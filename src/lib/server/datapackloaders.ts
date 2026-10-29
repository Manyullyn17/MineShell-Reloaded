import fs from 'node:fs/promises';
import path from 'node:path';
import { describeModJar } from './crashdiag';
import { changesWorldgen } from './mods/datapacks';

/**
 * Mods that load data packs from a folder of their own, for every world:
 * a pack's way to ship data packs, and a place users add theirs. When a pack
 * change drops such a mod, the folder's files come back after the change
 * (configmerge.ts) but nothing loads them, and one that adds world
 * generation the world has loaded can stop it loading. The preview says so.
 *
 * Folders as the mods read them (checked in the jars where at hand): Open
 * Loader 21 (1.21) reads config/openloader/packs (ATM10) and the server's own
 * datapacks/ (where CurseForge's launcher puts them), earlier builds
 * config/openloader/data or openloader/data; Paxi config/paxi/datapacks;
 * Global Packs global_packs/required_data and optional_data; KubeJS
 * kubejs/data. Recognised by mod id, or by file name for a jar that cannot
 * be read and for the new version's jars, which are not downloaded yet.
 */
export const DATAPACK_LOADERS: { ids: string[]; name: string; file: RegExp; folders: string[] }[] = [
	{ ids: ['openloader'], name: 'Open Loader', file: /^open-?loader[-_]/i, folders: ['config/openloader/packs', 'config/openloader/data', 'openloader/data', 'datapacks'] },
	{ ids: ['paxi'], name: 'Paxi', file: /^paxi[-_]/i, folders: ['config/paxi/datapacks'] },
	{ ids: ['globalpacks', 'globaldataandresourcepacks'], name: 'Global Packs', file: /^global[-_ ]?(data)?packs?[-_]/i, folders: ['global_packs/required_data', 'global_packs/optional_data'] },
	{ ids: ['kubejs'], name: 'KubeJS', file: /^kubejs-(neoforge|forge|fabric|quilt)?[-_]?\d/i, folders: ['kubejs/data'] }
];

export type LostDatapackLoader = {
	mod: string;
	/** The jar the change removes. */
	fileName: string;
	/** The user's own data packs it loaded (a zip or folder each), relative to the server folder. */
	packs: string[];
	/** Some of them add world generation. */
	worldgen: boolean;
};

/**
 * The data pack loaders a pack change drops (`removed` from mods/, none of
 * `added` taking over) whose folders hold data packs the installed version
 * did not ship (`shipped`; null when that is not known, then all count).
 */
export async function lostDatapackLoaders(
	root: string,
	removed: string[],
	added: string[],
	shipped: ((rel: string) => boolean) | null
): Promise<LostDatapackLoader[]> {
	const out: LostDatapackLoader[] = [];
	for (const fileName of removed) {
		const ids = (await describeModJar(path.join(root, 'mods', fileName)))?.ids ?? [];
		const loader = DATAPACK_LOADERS.find((l) => (ids.length ? l.ids.some((id) => ids.includes(id)) : l.file.test(fileName)));
		if (!loader || added.some((name) => loader.file.test(name))) continue;
		const packs: string[] = [];
		let worldgen = false;
		for (const folder of loader.folders) {
			for (const entry of await fs.readdir(path.join(root, folder), { withFileTypes: true }).catch(() => [])) {
				const rel = `${folder}/${entry.name}`;
				if (entry.isFile() && !/\.zip$/i.test(entry.name)) continue;
				if (shipped && (await shippedWhole(root, rel, entry.isDirectory(), shipped))) continue;
				packs.push(rel);
				worldgen ||= await changesWorldgen(path.join(root, rel), entry.isDirectory());
			}
		}
		if (packs.length) out.push({ mod: loader.name, fileName, packs, worldgen });
	}
	return out;
}

/** Every file of it came with the installed version: the pack's, not the user's. */
async function shippedWhole(root: string, rel: string, isDirectory: boolean, shipped: (rel: string) => boolean): Promise<boolean> {
	if (!isDirectory) return shipped(rel);
	const names = (await fs.readdir(path.join(root, rel), { recursive: true, withFileTypes: true }).catch(() => [])).filter((e) => e.isFile());
	return names.length > 0 && names.every((e) => shipped(path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join('/')));
}
