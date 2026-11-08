import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerInstance } from './db/schema';
import { safeJoin } from './files';
import { keepVersion, listVersions, readVersionBytes, type FileVersion } from './filehistory';
import { audit } from './instances';
import { NbtError, parseNbt, type NbtFile, type Tag } from './nbt';
import { applyTreeEdit, checkWritable, NbtEditError, parseTreeEdit, tagAt, toTree, type TreeEdit } from './nbtedit';
import { serverWorldName } from './packworld';
import { unitState } from './systemd';
import { worldFolderNames } from './worlds';
import { treeToSnbt, valueText, type Path, type TreeTag } from '#lib/shared/nbt.js';

/**
 * The NBT editor in Files: any file that is NBT as a whole (level.dat, mods' files in
 * world/data/, structures), whatever its name says. Big files are sent in parts: the first
 * BUDGET entries breadth-first, each list or compound at most PAGE at a time, the rest
 * fetched as the tree is opened (`slice`). Search runs here, on the whole file.
 *
 * Every change is saved on its own (as the player editor does), against the file's version
 * (sha1), written to a temp file and renamed over it. Files' earlier versions keep the file as
 * it was before each editing session (one per SESSION_MS). Not for the world a running
 * server is on: it holds what these files say and saves over them (level.dat, data/*.dat,
 * player files), so a change would be lost or mixed with the game's.
 */

export { NbtEditError };

/** Unpacked bytes the editor takes: a 19 MB structure cache took 280 MB of memory parsed. */
export const NBT_EDIT_MAX_BYTES = 8 * 1024 * 1024;
/** Entries sent in one piece, breadth-first. */
export const BUDGET = 2000;
/** Entries of one list or compound sent at a time. */
export const PAGE = 500;
/** Matches a search lists. */
export const SEARCH_LIMIT = 200;
/** SNBT a partly sent entry is edited as, at most. */
const SNBT_MAX_CHARS = 1_000_000;
/** One kept version per editing session. */
const SESSION_MS = 10 * 60_000;
const versionOf = (bytes: Buffer) => crypto.createHash('sha1').update(bytes).digest('hex');

type Loaded = { file: NbtFile; version: string; bytes: number; mtimeMs: number; size: number; at: number };

/** Parsed files, reused while unchanged on disk: opening a big tree asks for many slices. */
const cache = new Map<string, Loaded>();
const CACHE_MS = 2 * 60_000;
const CACHE_FILES = 2;

function parseWhole(bytes: Buffer): NbtFile {
	try {
		return parseNbt(bytes, NBT_EDIT_MAX_BYTES, true);
	} catch (err) {
		if (err instanceof NbtError) throw new NbtEditError(`This is not an NBT file the editor can open: ${err.message}`);
		throw new NbtEditError('This is not an NBT file the editor can open.');
	}
}

/** `fresh`: read from disk and not kept, for a save to change (kept once written). */
async function load(instance: ServerInstance, relative: string, fresh = false): Promise<Loaded> {
	const full = safeJoin(instance.path, relative);
	const stat = await fs.stat(full).catch(() => null);
	if (!stat?.isFile()) throw new NbtEditError('That file is not there any more.');
	const now = Date.now();
	for (const [key, entry] of cache) if (now - entry.at > CACHE_MS) cache.delete(key);
	const hit = cache.get(full);
	if (!fresh && hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
		hit.at = now;
		return hit;
	}
	const bytes = await fs.readFile(full);
	const loaded = { file: parseWhole(bytes), version: versionOf(bytes), bytes: bytes.length, mtimeMs: stat.mtimeMs, size: stat.size, at: now };
	if (!fresh) remember(full, loaded);
	return loaded;
}

function remember(full: string, loaded: Loaded) {
	cache.delete(full);
	cache.set(full, loaded);
	while (cache.size > CACHE_FILES) cache.delete(cache.keys().next().value!);
}

/** Forgets the parsed files (tests). */
export function forgetNbtFiles() {
	cache.clear();
}

/**
 * The first entries of a list or compound, breadth-first within `budget`: what is past it
 * comes as an empty list or compound with `more` set. `from`/`upTo` pick the root's entries.
 */
export function partialTree(tag: Tag, budget = BUDGET, from = 0, upTo = 0): TreeTag {
	if (tag.type !== 'list' && tag.type !== 'compound') return toTree(tag);
	let left = budget;
	const shell = (t: Extract<Tag, { type: 'list' | 'compound' }>): TreeTag =>
		t.type === 'list' ? { type: 'list', itemType: t.itemType, value: [], more: t.value.length } : { type: 'compound', value: [], more: t.value.length };
	const root = shell(tag) as Extract<TreeTag, { type: 'list' | 'compound' }>;
	const queue: [Extract<Tag, { type: 'list' | 'compound' }>, Extract<TreeTag, { type: 'list' | 'compound' }>, number, number][] = [
		[tag, root, from, Math.max(from + PAGE, upTo + 1)]
	];
	while (queue.length && left > 0) {
		const [src, dst, start, end] = queue.shift()!;
		const entries = src.value.slice(start, Math.min(end, start + Math.max(left, src === tag ? end - start : 0)));
		for (const entry of entries) {
			const [key, value] = src.type === 'compound' ? (entry as [string, Tag]) : [null, entry as Tag];
			const out = value.type === 'list' || value.type === 'compound' ? shell(value) : toTree(value);
			if (value.type === 'list' || value.type === 'compound') queue.push([value, out as Extract<TreeTag, { type: 'list' | 'compound' }>, 0, PAGE]);
			if (dst.type === 'compound') dst.value.push([key!, out]);
			else dst.value.push(out);
			left--;
		}
		dst.more = src.value.length - start - entries.length;
	}
	return root;
}

export type NbtFileView = {
	path: string;
	/** The root tag's name, mostly empty. */
	rootName: string;
	gzipped: boolean;
	bytes: number;
	version: string;
	tree: TreeTag;
	/** Why it cannot be changed now, or null. */
	readOnly: string | null;
	/** In one of the server's worlds: read when that world loads. */
	inWorld: boolean;
	versions: FileVersion[];
};

/** Why the file cannot be changed now: in the world the running server is on. */
export async function liveReason(instance: ServerInstance, relative: string): Promise<string | null> {
	const rel = path.relative(path.resolve(instance.path), safeJoin(instance.path, relative)).split(path.sep);
	if (rel.length < 2 || rel[0] !== (await serverWorldName(instance.path).catch(() => 'world'))) return null;
	const state = (await unitState(instance.id, { fresh: true })).active;
	if (state === 'inactive' || state === 'failed') return null;
	return `The server is running on ${rel[0]}: it keeps what this file says and saves over it, so a change made here would be lost. Stop the server to change it.`;
}

export async function readNbtFile(instance: ServerInstance, relative: string): Promise<NbtFileView> {
	const loaded = await load(instance, relative);
	return {
		path: relative,
		rootName: loaded.file.name,
		gzipped: loaded.file.gzipped,
		bytes: loaded.bytes,
		version: loaded.version,
		tree: partialTree(loaded.file.root),
		readOnly: await liveReason(instance, relative),
		inWorld: (await worldFolderNames(instance.path).catch(() => [] as string[])).includes(relative.split('/')[0]) && relative.includes('/'),
		versions: await listVersions(instance.path, relative).catch(() => [])
	};
}

/** Entries of the list or compound at `at` from position `from` (through `upTo`, if further). */
export async function nbtSlice(instance: ServerInstance, relative: string, at: Path, from: number, upTo = 0): Promise<{ version: string; tag: TreeTag }> {
	const loaded = await load(instance, relative);
	const tag = tagAt(loaded.file.root, at);
	if (tag.type !== 'list' && tag.type !== 'compound') throw new NbtEditError('That entry has no entries.');
	return { version: loaded.version, tag: partialTree(tag, BUDGET, Math.max(0, from), upTo) };
}

/** The whole entry at `at` as SNBT, for editing as text an entry the page holds only in part. */
export async function nbtSnbt(instance: ServerInstance, relative: string, at: Path): Promise<{ version: string; snbt: string }> {
	const loaded = await load(instance, relative);
	const snbt = treeToSnbt(toTree(tagAt(loaded.file.root, at)), 2);
	if (snbt.length > SNBT_MAX_CHARS) throw new NbtEditError('This entry is too large to edit as SNBT here: change what is inside it instead.');
	return { version: loaded.version, snbt };
}

export type NbtMatch = {
	path: Path;
	/** Each step's position in its list or compound, to open the tree that far. */
	positions: number[];
	type: string;
	/** The value as text, cut short; empty for lists and compounds. */
	value: string;
};

/** Entries whose key or value holds `query` (any case), in file order, at most SEARCH_LIMIT. */
export async function searchNbt(instance: ServerInstance, relative: string, query: string): Promise<{ matches: NbtMatch[]; more: boolean }> {
	const needle = query.trim().toLowerCase();
	if (!needle) return { matches: [], more: false };
	const { file } = await load(instance, relative);
	const matches: NbtMatch[] = [];
	let more = false;
	const visit = (tag: Tag, at: Path, positions: number[]) => {
		const entries: [string | null, Tag][] = tag.type === 'compound' ? tag.value : tag.type === 'list' ? tag.value.map((v) => [null, v]) : [];
		entries.forEach(([key, value], i) => {
			if (more) return;
			const here = [...at, key ?? i];
			const text = value.type === 'list' || value.type === 'compound' ? '' : valueText(toTree(value));
			if ((key !== null && key.toLowerCase().includes(needle)) || text.toLowerCase().includes(needle)) {
				if (matches.length === SEARCH_LIMIT) {
					more = true;
					return;
				}
				matches.push({ path: here, positions: [...positions, i], type: value.type, value: text.length > 120 ? `${text.slice(0, 120)}…` : text });
			}
			visit(value, here, [...positions, i]);
		});
	};
	visit(file.root, [], []);
	return { matches, more };
}

/** The NBT editor's edits as the browser sent them. */
export function parseNbtEdits(raw: unknown): TreeEdit[] {
	const bad = () => new NbtEditError('That change could not be read.');
	if (!Array.isArray(raw)) throw bad();
	return raw.map((e) => {
		if (!e || typeof e !== 'object') throw bad();
		const edit = parseTreeEdit(e as Record<string, unknown>, bad);
		if (!edit) throw bad();
		return edit;
	});
}

/** Keeps the file as it is on disk once per editing session, then writes `bytes` over it. */
async function replaceFile(instance: ServerInstance, relative: string, bytes: Buffer, now: number): Promise<void> {
	const full = safeJoin(instance.path, relative);
	const newest = (await listVersions(instance.path, relative).catch(() => []))[0];
	if (!newest || now - newest.savedAt > SESSION_MS) {
		// The server's change history lists the session with the file it changed.
		if (await keepVersion(instance.path, relative, bytes, now)) audit('file.saved', { instanceId: instance.id, detail: relative });
	}
	const tmp = `${full}.mineshell-tmp`;
	await fs.writeFile(tmp, bytes);
	await fs.rename(tmp, full);
}

/**
 * Applies `edits` to the file as it is on disk, if that is still `version`. Answers with the
 * new version and the list or compound at `refresh` as it is now (through `upTo`).
 */
export async function saveNbtEdits(
	instance: ServerInstance,
	relative: string,
	version: string,
	edits: TreeEdit[],
	refresh: { at: Path; upTo: number } | null = null,
	now = Date.now()
): Promise<{ version: string; tag: TreeTag | null }> {
	const live = await liveReason(instance, relative);
	if (live) throw new NbtEditError(live);
	// Read again rather than changing the cached tree: a refused edit must leave nothing behind.
	const loaded = await load(instance, relative, true);
	if (loaded.version !== version) throw new NbtEditError('The file changed since you opened it. Reload to see it as it is now.');
	for (const edit of edits) applyTreeEdit(loaded.file.root, edit);
	const bytes = checkWritable(loaded.file);
	await replaceFile(instance, relative, bytes, now);
	const stat = await fs.stat(safeJoin(instance.path, relative));
	const saved = { ...loaded, version: versionOf(bytes), bytes: bytes.length, mtimeMs: stat.mtimeMs, size: stat.size, at: now };
	remember(safeJoin(instance.path, relative), saved);
	let tag: TreeTag | null = null;
	if (refresh) {
		const container = tagAt(saved.file.root, refresh.at);
		if (container.type === 'list' || container.type === 'compound') tag = partialTree(container, BUDGET, 0, refresh.upTo);
	}
	return { version: saved.version, tag };
}

/** Puts an earlier version back, as a save: the file it replaces is kept too. */
export async function restoreNbtVersion(instance: ServerInstance, relative: string, version: string, id: string, now = Date.now()): Promise<string> {
	const live = await liveReason(instance, relative);
	if (live) throw new NbtEditError(live);
	const loaded = await load(instance, relative, true);
	if (loaded.version !== version) throw new NbtEditError('The file changed since you opened it. Reload to see it as it is now.');
	const bytes = await readVersionBytes(instance.path, relative, id).catch(() => null);
	if (!bytes) throw new NbtEditError('That version is not kept any more.');
	parseWhole(bytes);
	if (await keepVersion(instance.path, relative, bytes, now)) audit('file.saved', { instanceId: instance.id, detail: relative });
	const full = safeJoin(instance.path, relative);
	await fs.writeFile(`${full}.mineshell-tmp`, bytes);
	await fs.rename(`${full}.mineshell-tmp`, full);
	return versionOf(bytes);
}
