import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings, type ServerInstance } from './db/schema';
import { rconPassword } from './instances';
import { rconExec } from './rcon';
import { unitState } from './systemd';
import { compareVersions } from './java';
import { dimensionLabel, type Dimension } from './dimensions';

/**
 * Names for 1.12 mods' dimension folders, which say only a number (DIM-11325 is
 * Extra Utilities 2's Deep Dark). Forge knows them: `forge dimensions` lists
 * every registered dimension type with its ids, one line each ("deep_dark:
 * {-11325}"), so a running server is asked once per run, in the background, and
 * the answer kept. Until it has been, mods' configs give a guess: most keep a
 * dimension's number under a key or category that says so (ExtraUtils2:
 * `"dimension ids" { I:"Deep Dark"=-11325 }`). 1.13+ folders carry their ids.
 */

const KEY = (id: string) => `dimensions.names:${id}`;

type Stored = { run: number | null; names: Record<string, string> };

function read(instanceId: string): Stored | null {
	try {
		const row = db.select().from(settings).where(eq(settings.key, KEY(instanceId))).get();
		return row ? (JSON.parse(row.value) as Stored) : null;
	} catch {
		return null;
	}
}

function write(instanceId: string, value: Stored): void {
	const json = JSON.stringify(value);
	db.insert(settings).values({ key: KEY(instanceId), value: json }).onConflictDoUpdate({ target: settings.key, set: { value: json } }).run();
}

export function deleteDimensionNames(instanceId: string): void {
	db.delete(settings).where(eq(settings.key, KEY(instanceId))).run();
}

/**
 * `forge dimensions`' answer: dimension ids by number, named by their type ("deep_dark" -> Deep Dark).
 * Over RCON, 1.12 runs the lines together ("...by type:gallifrey: {624}AetherI: {4}The Abyssal
 * Wasteland: {50}..."), so entries are found by their `{ids}`, not by line. Type names can have
 * spaces and a namespace ("divinerpg:skythern: {423}").
 */
export function parseForgeDimensions(text: string): Map<number, string> {
	const out = new Map<number, string>();
	const body = text.replace(/^[\s\S]*?registered dimensions by type:/i, '');
	for (const m of body.matchAll(/([^{}\r\n]+?):\s*\{([-\d,\s]*)\}/g)) {
		const name = words(m[1].trim().replace(/^\w+:/, ''));
		if (!name) continue;
		for (const id of m[2].match(/-?\d+/g) ?? []) out.set(Number(id), name);
	}
	return out;
}

/** deep_dark, DeepDark, ExtraUtils2_Quarry -> Deep Dark, Deep Dark, ExtraUtils2 Quarry. */
function words(name: string): string {
	return name
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.split(/[\s_.-]+/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(' ');
}

/** A key or category with only "dimension", "id" and the like in it names nothing. */
const GENERIC = /^(?:dim(?:ension)?s?|ids?|world|type|number|config|general|settings|the|of)$/i;
/** Keys about something else that shares the numbers (biome ids, ore veins, counts): never a dimension. */
const NOT_A_DIMENSION = /biome|ore|vein|count|rate|chance|height|level|size|weight|spawn|amount|slot|light|multiplier|delay|radius|distance|max|min/i;
/** Config file names that do not name the mod: its folder does (compactmachines3/settings.cfg). */
const GENERIC_FILE = /^(?:settings|config|general|common|main|server|client)$/i;

function cleaned(name: string): string {
	return words(name)
		.split(' ')
		.filter((w) => !GENERIC.test(w))
		.join(' ');
}

/**
 * Guesses from Forge configs (config/**\/*.cfg): an integer entry equal to one of
 * `ids` whose key or enclosing category mentions a dimension. A key saying so
 * (erebus.cfg "Dimension ID of The Erebus") beats an id key in a dimension
 * category, which beats the category alone (ExtraUtils2's "dimension ids" {
 * "Deep Dark" }); keys about biomes, ores and counts never count (Journey's
 * "Cloudia biome ID" is 66 too). Named by the key, with the mod in front when
 * that is one word (DimDoors' baseDimensionID: "Dimdoors Base").
 */
export async function configDimensionNames(root: string, ids: number[]): Promise<Map<number, string>> {
	const wanted = new Set(ids);
	const out = new Map<number, string>();
	const ranks = new Map<number, number>();
	const files: string[] = [];
	const walk = async (dir: string, depth: number) => {
		if (depth > 3 || files.length > 2000) return;
		for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) await walk(full, depth + 1);
			else if (e.name.endsWith('.cfg')) files.push(full);
		}
	};
	await walk(path.join(root, 'config'), 0);
	for (const file of files.sort()) {
		const text = await fs.readFile(file, 'utf8').catch(() => '');
		if (text.length > 2_000_000) continue;
		const categories: string[] = [];
		for (const line of text.split(/\r?\n/)) {
			const open = line.match(/^\s*("([^"]+)"|[^#{}=\s][^#{}=]*?)\s*\{\s*$/);
			if (open) {
				categories.push(open[2] ?? open[1]);
				continue;
			}
			if (/^\s*\}\s*$/.test(line)) {
				categories.pop();
				continue;
			}
			const entry = line.match(/^\s*I:(?:"([^"]+)"|([^=\s]+))=(-?\d+)\s*$/);
			if (!entry) continue;
			const id = Number(entry[3]);
			if (!wanted.has(id)) continue;
			const key = entry[1] ?? entry[2];
			const category = categories.at(-1) ?? '';
			if (NOT_A_DIMENSION.test(key)) continue;
			const rank = /dim/i.test(key) ? 3 : /dim/i.test(category) && /id/i.test(key) ? 2 : /dim/i.test(category) ? 1 : 0;
			if (!rank || rank <= (ranks.get(id) ?? 0)) continue;
			const base = path.basename(file, '.cfg');
			const mod = words(GENERIC_FILE.test(base) ? path.basename(path.dirname(file)) : base);
			const name = cleaned(key);
			const named = !name ? mod : name.includes(' ') || mod.toLowerCase().includes(name.toLowerCase()) ? name : `${mod} ${name}`;
			if (!named) continue;
			out.set(id, named);
			ranks.set(id, rank);
		}
	}
	return out;
}

/** The numbered dimensions in a world: DIM<n> folders, without vanilla's DIM-1 and DIM1. */
function numbered(dimensions: Pick<Dimension, 'paths'>[]): number[] {
	const ids: number[] = [];
	for (const d of dimensions) {
		const m = path.basename(d.paths[0]).match(/^DIM(-?\d+)$/);
		if (m && m[1] !== '-1' && m[1] !== '1') ids.push(Number(m[1]));
	}
	return ids;
}

const asking = new Set<string>();

/** Asks a running Forge 1.12 server for its dimensions, once per run; never throws. */
export async function askForDimensionNames(instance: ServerInstance): Promise<void> {
	if (asking.has(instance.id)) return;
	if (!['forge', 'cleanroom'].includes(instance.modloader) || compareVersions(instance.minecraftVersion, '1.13') >= 0) return;
	const password = rconPassword(instance);
	if (!password) return;
	asking.add(instance.id);
	try {
		const state = await unitState(instance.id);
		if (state.active !== 'active') return;
		const run = state.activeEnterTimestamp || null;
		if (read(instance.id)?.run === run && run !== null) return;
		const [answer = ''] = await rconExec({ port: instance.rconPort, password }, ['forge dimensions']);
		const names = parseForgeDimensions(answer);
		if (!names.size) return;
		write(instance.id, { run, names: Object.fromEntries(names) });
	} catch {
		// Not up yet, or RCON refused: the next page load asks again.
	} finally {
		asking.delete(instance.id);
	}
}

export type DimensionName = { name: string; guess: boolean };

/** Names for a world's numbered dimensions: Forge's when it was asked, else guesses from configs. */
export async function dimensionNames(instance: ServerInstance, dimensions: Pick<Dimension, 'paths'>[]): Promise<Map<number, DimensionName>> {
	const ids = numbered(dimensions);
	const out = new Map<number, DimensionName>();
	if (!ids.length) return out;
	void askForDimensionNames(instance);
	const known = read(instance.id)?.names ?? {};
	const missing = ids.filter((id) => !(String(id) in known));
	const guessed = missing.length ? await configDimensionNames(instance.path, missing) : new Map<number, string>();
	for (const id of ids) {
		if (String(id) in known) out.set(id, { name: known[String(id)], guess: false });
		else if (guessed.has(id)) out.set(id, { name: guessed.get(id)!, guess: true });
	}
	return out;
}

/** A folder's label with its name: "Deep Dark (DIM-11325)", a guess "DIM-11325 (Deep Dark?)". */
export function namedLabel(folder: string, names: Map<number, DimensionName>): string {
	const m = folder.match(/^DIM(-?\d+)$/);
	const found = m ? names.get(Number(m[1])) : undefined;
	if (!found) return dimensionLabel(folder);
	return found.guess ? `${folder} (${found.name}?)` : `${found.name} (${folder})`;
}

/** The dimensions with their names in the labels; only numbered ones change (the overworld's first folder is region/). */
export async function withDimensionNames<T extends Dimension>(instance: ServerInstance, dimensions: T[]): Promise<T[]> {
	const names = await dimensionNames(instance, dimensions);
	if (!names.size) return dimensions;
	return dimensions.map((d) => {
		const folder = path.basename(d.paths[0]);
		return /^DIM-?\d+$/.test(folder) && !d.overworld ? { ...d, label: namedLabel(folder, names) } : d;
	});
}
