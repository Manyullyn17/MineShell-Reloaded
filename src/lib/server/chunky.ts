import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings, type ServerInstance } from './db/schema';
import { onlinePlayers, rconPassword } from './instances';
import { hasEnabledMod } from './mods';
import { readJavaProperties } from './properties';
import { rconExec } from './rcon';
import { unitState } from './systemd';
import type { PregenShape } from '#lib/shared/pregen.js';

/**
 * Chunk pre-generation with Chunky (Fabric, Forge, NeoForge; 1.14+, so not
 * 1.12). Unlike Spark, Chunky answers its commands synchronously, so RCON gets
 * the reply. Two things to know:
 * - Replies are in Chunky's language (its config, "en" by default). Live
 *   progress is read from `chunky progress` in English only; other languages
 *   show Chunky's own text.
 * - Saved tasks are written when a task stops (finished, paused, cancelled)
 *   and at shutdown, not while it runs: they tell which tasks can be
 *   continued, not how far a running one is.
 * Where it keeps them depends on its version: 1.3 on (Minecraft 1.19 on) has
 * config/chunky/config.json and a .properties file per task under
 * config/chunky/tasks/<namespace>/ (minecraft:overworld ->
 * minecraft/overworld.properties); 1.2 (1.16 to 1.19.2) has one
 * config/chunky.json holding the tasks too.
 */

export class ChunkyError extends Error {}

export function hasChunky(root: string): Promise<boolean> {
	return hasEnabledMod(root, 'chunky');
}

const chunkyDir = (root: string) => path.join(root, 'config', 'chunky');

/**
 * Chunky's config file: 1.3's, or 1.2's when only that one is there (a server
 * updated past 1.2 can keep the old file, which the new Chunky no longer reads).
 */
export async function chunkyConfigFile(root: string): Promise<{ file: string; legacy: boolean } | null> {
	const current = path.join(chunkyDir(root), 'config.json');
	const legacy = path.join(root, 'config', 'chunky.json');
	if (await fs.access(current).then(() => true, () => false)) return { file: current, legacy: false };
	if (await fs.access(legacy).then(() => true, () => false)) return { file: legacy, legacy: true };
	return null;
}

async function readConfig(root: string): Promise<{ file: string; legacy: boolean; config: Record<string, unknown> } | null> {
	const found = await chunkyConfigFile(root);
	if (!found) return null;
	try {
		const config = JSON.parse(await fs.readFile(found.file, 'utf8'));
		return config && typeof config === 'object' && !Array.isArray(config) ? { ...found, config } : null;
	} catch {
		return null;
	}
}

export async function chunkyLanguage(root: string): Promise<string> {
	const language = (await readConfig(root))?.config.language;
	return typeof language === 'string' ? language : 'en';
}

// ------------------------------------------------------------ saved tasks ---

export type SavedTask = {
	world: string;
	cancelled: boolean;
	shape: string;
	centerX: number;
	centerZ: number;
	radius: number;
	/** Rectangles and ellipses: the north-south radius (`radius` is east-west). */
	radiusZ: number | null;
	chunks: number;
	/** Time spent generating, ms. */
	time: number;
};

/** Java .properties as Chunky writes them: key=value lines, `\:` and `\=` escaped. */
export function parseProperties(text: string): Record<string, string> {
	return readJavaProperties(text);
}

/** Read like Chunky reads them: every .properties file under tasks/, at any depth; 1.2's from its config. */
export async function savedTasks(root: string): Promise<SavedTask[]> {
	const read = await readConfig(root);
	if (read?.legacy) return legacyTasks(read.config.tasks);
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
			radiusZ: props['radius-z'] === undefined ? null : Number(props['radius-z']),
			chunks: Number(props.chunks ?? 0),
			time: Number(props.time ?? 0)
		});
	}
	return tasks;
}

/** 1.2's "tasks": { "<world>": { cancelled, radius, radiusZ, centerX, centerZ, shape, count, time } }. */
function legacyTasks(raw: unknown): SavedTask[] {
	if (!raw || typeof raw !== 'object') return [];
	const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
	return Object.entries(raw as Record<string, Record<string, unknown>>)
		.filter(([, t]) => t && typeof t === 'object')
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([world, t]) => ({
			world,
			cancelled: t.cancelled === true,
			shape: typeof t.shape === 'string' ? t.shape : 'square',
			centerX: n(t.centerX),
			centerZ: n(t.centerZ),
			radius: n(t.radius),
			radiusZ: typeof t.radiusZ === 'number' ? t.radiusZ : null,
			chunks: n(t.count),
			time: n(t.time)
		}));
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

export const PREGEN_SHAPES: readonly PregenShape[] = ['square', 'rectangle', 'circle', 'ellipse'];
/** Rectangles and ellipses take `radiusZ` (north-south) besides `radius` (east-west). */
export type StartOptions = { world: string; shape: PregenShape; centerX: number; centerZ: number; radius: number; radiusZ?: number };

/** Minecraft's world border limit. */
const WORLD_LIMIT = 29_999_984;

/**
 * `chunky start <world> <shape> <x> <z> <radius> [radiusZ]`: the whole selection in one
 * command, so nothing depends on what `chunky world`/`radius` were set to before.
 * When the world has an unfinished task, Chunky asks for `chunky confirm` (start
 * over) or `chunky continue`; `needsConfirm` says so.
 */
export async function startPregen(instance: ServerInstance, opts: StartOptions): Promise<{ text: string; needsConfirm: boolean }> {
	if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(opts.world)) {
		throw new ChunkyError('A dimension is written like minecraft:overworld.');
	}
	if (!PREGEN_SHAPES.includes(opts.shape)) throw new ChunkyError('Pick a square, rectangle, circle or ellipse.');
	const twoRadii = opts.shape === 'rectangle' || opts.shape === 'ellipse';
	for (const n of [opts.centerX, opts.centerZ]) {
		if (!Number.isFinite(n) || Math.abs(n) > WORLD_LIMIT) throw new ChunkyError('The center is outside the world.');
	}
	for (const r of twoRadii ? [opts.radius, opts.radiusZ] : [opts.radius]) {
		if (!Number.isInteger(r) || r! < 16 || r! > WORLD_LIMIT) throw new ChunkyError('A radius is a whole number of blocks, at least 16.');
	}
	const radii = twoRadii ? `${opts.radius} ${opts.radiusZ}` : `${opts.radius}`;
	const text = await chunky(instance, [`chunky start ${opts.world} ${opts.shape} ${Math.round(opts.centerX)} ${Math.round(opts.centerZ)} ${radii}`]);
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

// ------------------------------------------------ continue after a restart ---

const continueKey = (id: string) => `chunky.continueOnRestart:${id}`;

/**
 * Whether Chunky picks its unfinished tasks up again when the server starts
 * (its continueOnRestart, off in Chunky itself). On unless turned off here:
 * otherwise every scheduled restart leaves pre-generation stopped until
 * someone presses Continue.
 */
export function continuesOnRestart(instanceId: string): boolean {
	return readSetting<unknown>(continueKey(instanceId), true) !== false;
}

export async function setContinuesOnRestart(instance: ServerInstance, enabled: boolean): Promise<void> {
	writeSetting(continueKey(instance.id), enabled);
	await applyChunkyConfig(instance);
}

/**
 * Before every start and restart (instances.ts): continueOnRestart as set
 * here, written into Chunky's config. Every time, because Chunky reads it only
 * when the server starts, and 1.2 writes the value it holds back into its file
 * whenever it saves a task, shutdown included. Only a config Chunky already made is changed: older
 * versions may not cope with one missing the rest of its fields.
 */
export async function applyChunkyConfig(instance: ServerInstance): Promise<void> {
	if (!(await hasChunky(instance.path))) return;
	const read = await readConfig(instance.path);
	if (!read) return;
	const wanted = continuesOnRestart(instance.id);
	if (read.config.continueOnRestart === wanted) return;
	await fs.writeFile(read.file, JSON.stringify({ ...read.config, continueOnRestart: wanted }, null, 2) + '\n');
}

export function deleteChunkySettings(instanceId: string): void {
	db.delete(settings).where(eq(settings.key, autoKey(instanceId))).run();
	db.delete(settings).where(eq(settings.key, pausedKey(instanceId))).run();
	db.delete(settings).where(eq(settings.key, continueKey(instanceId))).run();
}
