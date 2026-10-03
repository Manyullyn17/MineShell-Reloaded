import path from 'node:path';
import { parseProperties, readProperties } from './properties';
import type { PackDownload, ParsedPack } from './packs';

/**
 * Files a pack ships inside its world folder - nearly always data packs
 * (`world/datapacks/...`), occasionally per-world configs like Forge's
 * `world/serverconfig/`.
 *
 * The world folder is whatever `level-name` says, on both sides: the pack's
 * own server.properties names the folder its files are under, the server's
 * names where they belong. The two differ when someone renamed the server's
 * world, or a pack ships its world files under a name of its own.
 *
 * A pack version change never moves or replaces the world. It syncs the
 * pack's data packs (the ones the previous version shipped and this one does
 * not are moved to old-configs, new and changed ones are written, the user's
 * own are left alone) and writes other world files only where none exist.
 */

const DEFAULT_WORLD = 'world';

/**
 * A usable world folder path relative to the server folder, or null for one
 * that would point outside it (absolute, `..`) or is empty. `level-name` may
 * contain a subfolder (`worlds/main`).
 */
export function cleanWorldPath(value: string | undefined | null): string | null {
	const trimmed = (value ?? '').trim().replace(/\\/g, '/');
	if (!trimmed || trimmed.startsWith('/')) return null;
	const normalised = path.posix.normalize(trimmed).replace(/\/+$/, '');
	if (!normalised || normalised === '.' || normalised.split('/').includes('..')) return null;
	return normalised;
}

/** The world folder the server uses. */
export async function serverWorldName(root: string): Promise<string> {
	return cleanWorldPath((await readProperties(root)).values['level-name']) ?? DEFAULT_WORLD;
}

/** `level-name` in the pack's own server.properties (server-overrides wins, as when applying), if it sets one. */
export function packLevelName(pack: ParsedPack): string | null {
	for (const prefix of ['server-overrides/', 'overrides/']) {
		const entry = pack.overrideEntries.find((e) => e === `${prefix}server.properties`);
		const text = entry ? pack.zip?.readAsText(entry) : null;
		if (text) {
			const name = cleanWorldPath(parseProperties(text).values['level-name']);
			if (name) return name;
		}
	}
	return null;
}

function shipsUnder(pack: ParsedPack, folder: string): boolean {
	const prefix = `${folder}/`;
	return (
		pack.overrideEntries.some((e) => overrideRelative(e).startsWith(prefix)) ||
		pack.downloads.some((d) => d.target.startsWith(prefix))
	);
}

/**
 * The folder the pack's own world files are under: its level-name - unless
 * nothing is under that and something is under `world/`, a pack that renamed
 * its world without moving its files.
 */
export function packWorldName(pack: ParsedPack): string {
	const named = packLevelName(pack) ?? DEFAULT_WORLD;
	if (named !== DEFAULT_WORLD && !shipsUnder(pack, named) && shipsUnder(pack, DEFAULT_WORLD)) return DEFAULT_WORLD;
	return named;
}

/** A path in the pack moved from its world folder to the server's; anything else unchanged. */
export function mapWorldPath(rel: string, packWorld: string, serverWorld: string): string {
	if (packWorld === serverWorld || !rel.startsWith(`${packWorld}/`)) return rel;
	return `${serverWorld}/${rel.slice(packWorld.length + 1)}`;
}

export type PackWorldFile = {
	/** Path inside the world folder, e.g. `datapacks/Terralith.zip`. */
	rel: string;
	/** The override archive entry it comes from, or the download that fetches it. */
	entry?: string;
	download?: PackDownload;
};

function overrideRelative(entry: string): string {
	return entry.replace(/^(server-overrides|overrides)\//, '');
}

/** Every file the pack ships under its world folder. */
export function packWorldFiles(pack: ParsedPack, packWorld = packWorldName(pack)): PackWorldFile[] {
	const prefix = `${packWorld}/`;
	const files = new Map<string, PackWorldFile>();
	for (const entry of pack.overrideEntries) {
		const rel = overrideRelative(entry);
		if (rel.startsWith(prefix) && rel.length > prefix.length) {
			// server-overrides wins over overrides for the same file.
			if (!files.has(rel.slice(prefix.length)) || entry.startsWith('server-overrides/')) {
				files.set(rel.slice(prefix.length), { rel: rel.slice(prefix.length), entry });
			}
		}
	}
	for (const download of pack.downloads) {
		if (download.target.startsWith(prefix)) {
			const rel = download.target.slice(prefix.length);
			files.set(rel, { rel, download });
		}
	}
	return [...files.values()];
}

/**
 * The data packs among them, by their name in `datapacks/`: a zip, or a
 * folder data pack (`datapacks/MyPack/pack.mcmeta` -> `MyPack`).
 */
export function datapackNames(files: PackWorldFile[]): string[] {
	const names = new Set<string>();
	for (const f of files) {
		const [dir, name] = f.rel.split('/');
		if (dir === 'datapacks' && name) names.add(name);
	}
	return [...names].sort();
}

/** True for a world file that belongs to a data pack. */
export function isDatapackFile(rel: string): boolean {
	return rel.startsWith('datapacks/') && rel.split('/').length >= 2;
}
