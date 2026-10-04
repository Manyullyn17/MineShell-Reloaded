import fs from 'node:fs/promises';
import path from 'node:path';
import { serverWorldName } from './packworld';

/**
 * A world's dimensions as folders on disk, for resetting or restoring one:
 * - the overworld is the level folder's own region/, entities/ and poi/ (its
 *   level.dat, player data and data/ belong to the whole world and stay);
 * - vanilla keeps the nether and end in DIM-1/ and DIM1/, mods add DIM<n>/
 *   (1.12) or their own named folders, and 1.16+ datapack and mod dimensions
 *   live in dimensions/<namespace>/<name>/;
 * - Bukkit-style servers keep world_nether/ and world_the_end/ next to it.
 * A subfolder counts as a dimension when it holds region/ or entities/.
 */

export type Dimension = {
	/** minecraft:the_nether, twilightforest:twilight_forest, or the folder name when there is no id. */
	id: string;
	label: string;
	/** Folders that make up the dimension, relative to the server folder. */
	paths: string[];
	overworld: boolean;
};

/** The overworld's own terrain folders; 1.12 has only region/. */
export const OVERWORLD_FOLDERS = ['region', 'entities', 'poi'];

export async function isDimensionFolder(dir: string): Promise<boolean> {
	const names = new Set(
		(await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name)
	);
	return names.has('region') || names.has('entities');
}

const VANILLA: Record<string, { id: string; label: string }> = {
	'DIM-1': { id: 'minecraft:the_nether', label: 'The Nether' },
	DIM1: { id: 'minecraft:the_end', label: 'The End' }
};

/** "DIM-1" -> The Nether; other folders keep their name. */
export function dimensionLabel(folder: string): string {
	return VANILLA[folder]?.label ?? folder;
}

async function exists(p: string): Promise<boolean> {
	return fs.access(p).then(
		() => true,
		() => false
	);
}

/**
 * `world` defaults to the server's level-name; a snapshot folder has no
 * server.properties, so reading one passes the server's.
 */
export async function listDimensions(root: string, world?: string): Promise<Dimension[]> {
	world ??= await serverWorldName(root);
	const dir = path.join(root, world);
	const dimensions: Dimension[] = [];

	const overworld: string[] = [];
	for (const name of OVERWORLD_FOLDERS) {
		if (await exists(path.join(dir, name))) overworld.push(path.join(world, name));
	}
	if (overworld.length) dimensions.push({ id: 'minecraft:overworld', label: 'Overworld', paths: overworld, overworld: true });

	for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isDirectory() || OVERWORLD_FOLDERS.includes(entry.name)) continue;
		const rel = path.join(world, entry.name);
		if (entry.name === 'dimensions') {
			for (const ns of await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
				if (!ns.isDirectory()) continue;
				for (const dim of await fs.readdir(path.join(root, rel, ns.name), { withFileTypes: true }).catch(() => [])) {
					const dimRel = path.join(rel, ns.name, dim.name);
					if (dim.isDirectory() && (await isDimensionFolder(path.join(root, dimRel)))) {
						const id = `${ns.name}:${dim.name}`;
						dimensions.push({ id, label: id, paths: [dimRel], overworld: false });
					}
				}
			}
		} else if (await isDimensionFolder(path.join(root, rel))) {
			const vanilla = VANILLA[entry.name];
			dimensions.push({ id: vanilla?.id ?? entry.name, label: vanilla?.label ?? entry.name, paths: [rel], overworld: false });
		}
	}

	for (const [suffix, id, label] of [
		['_nether', 'minecraft:the_nether', 'The Nether'],
		['_the_end', 'minecraft:the_end', 'The End']
	]) {
		const sibling = `${world}${suffix}`;
		if (await exists(path.join(root, sibling))) dimensions.push({ id, label, paths: [sibling], overworld: false });
	}
	return dimensions;
}

/** Looks a dimension up by the first of its paths, which is what the page sends. */
export async function findDimension(root: string, key: string): Promise<Dimension | null> {
	return (await listDimensions(root)).find((d) => d.paths[0] === key) ?? null;
}
