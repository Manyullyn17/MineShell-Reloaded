import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings, type ServerInstance } from './db/schema';
import { onlinePlayers, rconPassword } from './instances';
import { hasEnabledMod } from './mods';
import { rconExec } from './rcon';
import { unitState } from './systemd';

/**
 * Chunk pre-generation with Chunky (Fabric, Forge, NeoForge; 1.14+, so not
 * 1.12). Unlike Spark, Chunky answers its commands synchronously, so RCON gets
 * the reply. Two things to know:
 * - Replies are in Chunky's language (config/chunky/config.json, "en" by
 *   default). Live progress is read from `chunky progress` in English only;
 *   other languages show Chunky's own text.
 * - config/chunky/tasks/<namespace>/<path>.properties (minecraft:overworld ->
 *   minecraft/overworld.properties) is written when a task stops
 *   (finished, paused, cancelled) and at shutdown, not while it runs: it tells
 *   which tasks can be continued, not how far a running one is.
 */

export class ChunkyError extends Error {}

export function hasChunky(root: string): Promise<boolean> {
	return hasEnabledMod(root, 'chunky');
}

const chunkyDir = (root: string) => path.join(root, 'config', 'chunky');

export async function chunkyLanguage(root: string): Promise<string> {
	try {
		const config = JSON.parse(await fs.readFile(path.join(chunkyDir(root), 'config.json'), 'utf8'));
		return typeof config.language === 'string' ? config.language : 'en';
	} catch {
		return 'en';
	}
}

// ------------------------------------------------------------ saved tasks ---

export type SavedTask = {
	world: string;
	cancelled: boolean;
	shape: string;
	centerX: number;
	centerZ: number;
	radius: number;
	chunks: number;
	/** Time spent generating, ms. */
	time: number;
};

/** Java .properties as Chunky writes them: key=value lines, `\:` and `\=` escaped. */
export function parseProperties(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim() || /^\s*[#!]/.test(line)) continue;
		const m = line.match(/^\s*((?:\\.|[^=:\s\\])+)\s*[=:]?\s*(.*)$/);
		if (m) values[m[1].replace(/\\(.)/g, '$1')] = m[2].replace(/\\(.)/g, '$1');
	}
	return values;
}

/** Read like Chunky reads them: every .properties file under tasks/, at any depth. */
export async function savedTasks(root: string): Promise<SavedTask[]> {
	const dir = path.join(chunkyDir(root), 'tasks');
	const names = (await fs.readdir(dir, { recursive: true }).catch(() => [] as string[])) as string[];
	const tasks: SavedTask[] = [];
	for (const name of names.filter((n) => n.endsWith('.properties')).sort()) {
		const props = parseProperties(await fs.readFile(path.join(dir, name), 'utf8').catch(() => ''));
		if (!props.world) continue;
		tasks.push({
			world: props.world,
			cancelled: props.cancelled === 'true',
			shape: props.shape ?? 'square',
			centerX: Number(props['center-x'] ?? 0),
			centerZ: Number(props['center-z'] ?? 0),
			radius: Number(props.radius ?? 0),
			chunks: Number(props.chunks ?? 0),
			time: Number(props.time ?? 0)
		});
	}
	return tasks;
}

// --------------------------------------------------------------- progress ---

export type TaskProgress = {
	world: string;
	chunks: number;
	percent: number;
	etaSeconds: number;
	/** Chunks per second. */
	rate: number;
};

export type ChunkyStatus = {
	/** Parsed running tasks; empty when nothing runs or the language is not English. */
	running: TaskProgress[];
	/** What Chunky said, colour codes and its prefix removed. */
	text: string;
};

/** Colour codes (`§a`, Chunky's own `&c`) and the "[Chunky] " prefix. */
export function plainChunky(text: string): string {
	return text
		.replace(/[§&][0-9a-fk-or]/gi, '')
		.split('\n')
		.map((line) => line.replace(/^\s*\[Chunky\]\s*/, '').trim())
		.filter(Boolean)
		.join('\n');
}

/** "%.2f" and "%,d" follow the JVM's locale: "1,234" or "1.234", "12.50" or "12,50". */
const count = (s: string) => Number(s.replace(/[^\d]/g, ''));
const decimal = (s: string) => Number(s.replace(/[.,](?=\d+$)/, '#').replace(/[.,\s]/g, '').replace('#', '.'));

/** task_update: "Task running for %s. Processed: %s chunks (%s%%), ETA: %s:%s:%s, Rate: %s cps, Current: %s, %s". */
export function parseProgress(text: string): TaskProgress[] {
	const tasks: TaskProgress[] = [];
	const pattern = /Task running for (\S+)\. Processed: ([\d.,\s]+) chunks \(([\d.,]+)%\), ETA: (\d+):(\d+):(\d+), Rate: ([\d.,]+) cps/g;
	for (const m of text.matchAll(pattern)) {
		tasks.push({
			world: m[1],
			chunks: count(m[2]),
			percent: decimal(m[3]),
			etaSeconds: Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6]),
			rate: decimal(m[7])
		});
	}
	return tasks;
}

function rconTarget(instance: ServerInstance) {
	const password = rconPassword(instance);
	if (!password) throw new ChunkyError('RCON has no password for this server, so MineShell cannot talk to Chunky.');
	return { port: instance.rconPort, password };
}

async function chunky(instance: ServerInstance, commands: string[]): Promise<string> {
	try {
		const answers = await rconExec(rconTarget(instance), commands);
		return plainChunky(answers.join('\n'));
	} catch (err) {
		if (err instanceof ChunkyError) throw err;
		throw new ChunkyError('The server did not answer over RCON. Is it running?');
	}
}

export async function chunkyStatus(instance: ServerInstance): Promise<ChunkyStatus> {
	const text = await chunky(instance, ['chunky progress']);
	return { running: parseProgress(text), text };
}

// --------------------------------------------------------------- commands ---

export type StartOptions = { world: string; shape: 'square' | 'circle'; centerX: number; centerZ: number; radius: number };

/** Minecraft's world border limit. */
const WORLD_LIMIT = 29_999_984;

/**
 * `chunky start <world> <shape> <x> <z> <radius>`: the whole selection in one
 * command, so nothing depends on what `chunky world`/`radius` were set to before.
 * When the world has an unfinished task, Chunky asks for `chunky confirm` (start
 * over) or `chunky continue`; `needsConfirm` says so.
 */
export async function startPregen(instance: ServerInstance, opts: StartOptions): Promise<{ text: string; needsConfirm: boolean }> {
	if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(opts.world)) {
		throw new ChunkyError('A dimension is written like minecraft:overworld.');
	}
	if (opts.shape !== 'square' && opts.shape !== 'circle') throw new ChunkyError('Pick square or circle.');
	for (const n of [opts.centerX, opts.centerZ]) {
		if (!Number.isFinite(n) || Math.abs(n) > WORLD_LIMIT) throw new ChunkyError('The center is outside the world.');
	}
	if (!Number.isInteger(opts.radius) || opts.radius < 16 || opts.radius > WORLD_LIMIT) {
		throw new ChunkyError('The radius is a whole number of blocks, at least 16.');
	}
	const text = await chunky(instance, [
		`chunky start ${opts.world} ${opts.shape} ${Math.round(opts.centerX)} ${Math.round(opts.centerZ)} ${opts.radius}`
	]);
	// The confirmation names the command itself, whatever the language.
	return { text, needsConfirm: text.includes('chunky confirm') };
}

/** Starts over after startPregen asked; replaces the unfinished task. */
export function confirmPregen(instance: ServerInstance): Promise<string> {
	return chunky(instance, ['chunky confirm']);
}

const worldArg = (world: string | null) => {
	if (world && !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(world)) throw new ChunkyError('Unknown dimension.');
	return world ? ` ${world}` : '';
};

export function pausePregen(instance: ServerInstance, world: string | null = null): Promise<string> {
	return chunky(instance, [`chunky pause${worldArg(world)}`]);
}

export function continuePregen(instance: ServerInstance, world: string | null = null): Promise<string> {
	return chunky(instance, [`chunky continue${worldArg(world)}`]);
}

/** Chunky asks to confirm a cancel (a cancelled task cannot be continued); the page already did. */
export function cancelPregen(instance: ServerInstance, world: string | null = null): Promise<string> {
	return chunky(instance, [`chunky cancel${worldArg(world)}`, 'chunky confirm']);
}

// ------------------------------------------- pause while players are online ---

const autoKey = (id: string) => `chunky.pauseWhenOnline:${id}`;
const pausedKey = (id: string) => `chunky.pausedForPlayers:${id}`;

function readSetting<T>(key: string, fallback: T): T {
	const row = db.select().from(settings).where(eq(settings.key, key)).get();
	try {
		return row ? (JSON.parse(row.value) as T) : fallback;
	} catch {
		return fallback;
	}
}

function writeSetting(key: string, value: unknown): void {
	const json = JSON.stringify(value);
	db.insert(settings).values({ key, value: json }).onConflictDoUpdate({ target: settings.key, set: { value: json } }).run();
}

export function pausesForPlayers(instanceId: string): boolean {
	return readSetting<unknown>(autoKey(instanceId), false) === true;
}

export function setPausesForPlayers(instanceId: string, enabled: boolean): void {
	writeSetting(autoKey(instanceId), enabled);
	if (!enabled) writeSetting(pausedKey(instanceId), []);
}

/** Worlds MineShell paused because someone came online; kept in the database so a MineShell restart still resumes them. */
export function pausedForPlayers(instanceId: string): string[] {
	const worlds = readSetting<unknown>(pausedKey(instanceId), []);
	return Array.isArray(worlds) ? worlds.filter((w): w is string => typeof w === 'string') : [];
}

/**
 * Called by the scheduler every 30 s: pauses running pre-generation while
 * anyone is online and continues what it paused once the server is empty.
 * Only with Chunky in English, where MineShell can read which tasks run; it
 * never continues a task the user paused.
 */
export async function autoPauseForPlayers(instance: ServerInstance): Promise<void> {
	if (!pausesForPlayers(instance.id)) return;
	if ((await unitState(instance.id)).active !== 'active') return;
	if ((await chunkyLanguage(instance.path)) !== 'en') return;
	const players = await onlinePlayers(instance);
	if (!players) return;
	const paused = pausedForPlayers(instance.id);
	if (players.online > 0) {
		const { running } = await chunkyStatus(instance);
		if (!running.length) return;
		for (const task of running) await pausePregen(instance, task.world);
		writeSetting(pausedKey(instance.id), [...new Set([...paused, ...running.map((t) => t.world)])]);
	} else if (paused.length) {
		for (const world of paused) await continuePregen(instance, world);
		writeSetting(pausedKey(instance.id), []);
	}
}

export function deleteChunkySettings(instanceId: string): void {
	db.delete(settings).where(eq(settings.key, autoKey(instanceId))).run();
	db.delete(settings).where(eq(settings.key, pausedKey(instanceId))).run();
}
