import fs from 'node:fs/promises';
import path from 'node:path';
import { compareVersions } from './java';
import { child, parseNbt } from './nbt';
import { cleanWorldPath, serverWorldName } from './packworld';
import { snapshotOfWorld, type Snapshot } from './snapshots';
import type { ServerInstance } from './db/schema';

/**
 * A server's worlds: every world folder in the server folder, of which the
 * one `level-name` names is active. The others stay where they are, so making
 * another one active rewrites `level-name` and moves no world (`switchWorld`
 * in world.ts).
 *
 * What MineShell keeps per world while it is not active - its name, the
 * generation settings and pack data packs it had, what it last ran on, its
 * kept map's render time - is in `.mineshell/worlds.json`, next to the worlds
 * themselves, so a copy of the server has it too.
 */

/** The mod bisect assistant's throwaway world (bisect.ts): never one of the server's worlds. */
export const BISECT_WORLD = 'mineshell-bisect-world';

const META_FILE = path.join('.mineshell', 'worlds.json');

/** server.properties keys that belong to a world (how it was generated), saved and put back with it. */
export const WORLD_PROPERTY_KEYS = ['level-seed', 'level-type', 'generator-settings'] as const;

export type WorldRun = {
	minecraftVersion: string;
	modloader: string;
	modloaderVersion: string | null;
	packVersionName: string | null;
};

export type WorldMeta = {
	/** The user's name for it; the folder name when unset. */
	name?: string;
	createdAt?: number;
	/** WORLD_PROPERTY_KEYS as they were while it was last active. */
	properties?: Record<string, string>;
	/** server_instances.pack_datapacks while it was last active. */
	packDatapacks?: string | null;
	/** What the server ran when it stopped being active (or the snapshot it came from). */
	lastRun?: WorldRun;
	/** When another world was made active instead. */
	leftAt?: number;
	/** Its map's render time and size, while its map is kept aside. */
	map?: { lastRenderAt: number | null; sizeBytes: number | null };
};

type MetaFile = { worlds: Record<string, WorldMeta> };

async function exists(p: string): Promise<boolean> {
	return fs.access(p).then(
		() => true,
		() => false
	);
}

export async function readWorldMeta(root: string): Promise<MetaFile> {
	try {
		const parsed = JSON.parse(await fs.readFile(path.join(root, META_FILE), 'utf8')) as Partial<MetaFile>;
		return { worlds: parsed.worlds && typeof parsed.worlds === 'object' ? parsed.worlds : {} };
	} catch {
		return { worlds: {} };
	}
}

export async function writeWorldMeta(root: string, meta: MetaFile): Promise<void> {
	const file = path.join(root, META_FILE);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(`${file}.tmp`, JSON.stringify(meta, null, 2), 'utf8');
	await fs.rename(`${file}.tmp`, file);
}

const SIBLING = /_(nether|the_end)$/;

/**
 * The world folders in the server folder: top-level folders with a level.dat,
 * worlds MineShell made (recorded, maybe not generated yet: left before its
 * first start, a new world has no folder, only its seed) and the active one
 * (which may not exist yet, or be a subfolder). Bukkit-style `_nether` and
 * `_the_end` siblings belong to their world and are not worlds of their own.
 * The active one first, the rest by name.
 */
export async function worldFolderNames(root: string): Promise<string[]> {
	const found = new Set<string>();
	for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === BISECT_WORLD) continue;
		if (await exists(path.join(root, entry.name, 'level.dat'))) found.add(entry.name);
	}
	for (const [folder, own] of Object.entries((await readWorldMeta(root)).worlds)) {
		if (cleanWorldPath(folder) === folder && folder !== BISECT_WORLD && (own.createdAt || (await exists(path.join(root, folder))))) found.add(folder);
	}
	const active = await serverWorldName(root);
	found.add(active);
	for (const name of [...found]) {
		const base = name.replace(SIBLING, '');
		if (base !== name && found.has(base)) found.delete(name);
	}
	return [...found].sort((a, b) => (a === active ? -1 : b === active ? 1 : a.localeCompare(b, undefined, { numeric: true })));
}

/** A world's folders that exist: the world and its Bukkit-style siblings. */
export async function foldersOfWorld(root: string, world: string): Promise<string[]> {
	const found: string[] = [];
	for (const candidate of [world, `${world}_nether`, `${world}_the_end`]) {
		if (await exists(path.join(root, candidate))) found.push(candidate);
	}
	return found;
}

/** The Minecraft version that last saved the world (level.dat Data.Version.Name, 1.9+); null when unknown. */
export async function levelVersion(dir: string): Promise<string | null> {
	try {
		const level = parseNbt(await fs.readFile(path.join(dir, 'level.dat')));
		const name = child(child(child(level.root, 'Data'), 'Version'), 'Name');
		return name?.type === 'string' ? name.value : null;
	} catch {
		return null;
	}
}

export type WorldInfo = {
	folder: string;
	name: string;
	active: boolean;
	/** Its folders on disk (the world and siblings); empty for one not generated yet. */
	folders: string[];
	/** Has a level.dat: the server has run on it. */
	generated: boolean;
	/** What last saved it, from level.dat. */
	version: string | null;
	lastRun: WorldRun | null;
	createdAt: number | null;
	leftAt: number | null;
	/** A map of it is kept for when it is active again. */
	mapKept: boolean;
	/** That map's size, as measured when it was rendered. */
	mapBytes: number | null;
};

export async function listWorlds(instance: Pick<ServerInstance, 'path'>): Promise<WorldInfo[]> {
	const root = instance.path;
	const meta = await readWorldMeta(root);
	const active = await serverWorldName(root);
	return Promise.all(
		(await worldFolderNames(root)).map(async (folder) => {
			const own = meta.worlds[folder] ?? {};
			const generated = await exists(path.join(root, folder, 'level.dat'));
			return {
				folder,
				name: own.name || folder,
				active: folder === active,
				folders: await foldersOfWorld(root, folder),
				generated,
				version: generated ? await levelVersion(path.join(root, folder)) : null,
				lastRun: own.lastRun ?? null,
				createdAt: own.createdAt ?? null,
				leftAt: own.leftAt ?? null,
				mapKept: !!own.map,
				mapBytes: own.map?.sizeBytes ?? null
			};
		})
	);
}

/**
 * The world a snapshot is of, as a folder: the manifest's, else the first of
 * the server's worlds its folders fit, else its first folder's world.
 */
export function snapshotWorldFolder(snapshot: Pick<Snapshot, 'world' | 'worlds'>, worlds: string[]): string {
	if (snapshot.world !== undefined) return snapshot.world;
	return worlds.find((w) => snapshotOfWorld(snapshot, w)) ?? (snapshot.worlds[0] ?? '').replace(SIBLING, '');
}

export const WORLD_NAME_MAX = 60;

/** A world's name as the user typed it, tidied; throws on an empty or long one. */
export function cleanWorldName(raw: string): string {
	const name = raw.replace(/\s+/g, ' ').trim();
	if (!name) throw new Error('Give the world a name.');
	if (name.length > WORLD_NAME_MAX) throw new Error(`A world's name is at most ${WORLD_NAME_MAX} characters.`);
	return name;
}

/** Top-level names a pack or loader may use for itself: never a new world's folder. */
const RESERVED = new Set(['mods', 'config', 'defaultconfigs', 'kubejs', 'scripts', 'resources', 'libraries', 'logs', 'crash-reports', 'old-configs', 'plugins', 'versions', 'saves']);

/** A folder name for a new world called `name` that nothing in the server folder has. */
export async function freeWorldFolder(root: string, name: string): Promise<string> {
	const slug =
		name
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.replace(SIBLING, '')
			.slice(0, 40) || 'world';
	const taken = async (folder: string) =>
		RESERVED.has(folder) || folder === BISECT_WORLD || (await foldersOfWorld(root, folder)).length > 0 || (await exists(path.join(root, folder)));
	let folder = slug;
	for (let n = 2; await taken(folder); n++) folder = `${slug}-${n}`;
	return folder;
}

const RELEASE = /^\d+(\.\d+)+$/;

/**
 * Why switching to this world may damage it, or null: it last ran on a newer
 * Minecraft than the server's (a pack rollback can take the server back), and
 * Minecraft does not load a world into an older version.
 */
export function newerWorldWarning(instance: Pick<ServerInstance, 'minecraftVersion'>, world: WorldInfo): string | null {
	const version = world.version ?? world.lastRun?.minecraftVersion ?? null;
	if (!version || !RELEASE.test(version) || !RELEASE.test(instance.minecraftVersion)) return null;
	if (compareVersions(version, instance.minecraftVersion) <= 0) return null;
	return `${world.name} last ran on Minecraft ${version}, newer than this server's ${instance.minecraftVersion}. An older version may not load it, or may damage it.`;
}

/** The world last ran with another loader: its modded blocks and items may be gone once loaded. Only shown. */
export function otherLoaderWarning(instance: Pick<ServerInstance, 'modloader'>, world: WorldInfo): string | null {
	const loader = world.lastRun?.modloader;
	if (!loader || loader === instance.modloader) return null;
	return `${world.name} last ran with ${loader}, not ${instance.modloader}: blocks and items of mods this server does not have are lost once it loads.`;
}
