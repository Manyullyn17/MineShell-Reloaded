import fs from 'node:fs/promises';
import path from 'node:path';
import { describeModJar, indexMods } from './crashdiag';
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
type DatapackLoader = {
	ids: string[];
	name: string;
	file: RegExp;
	folders: string[];
	/** The folders a build reads, by its version (from the jar's name); every one when not known. */
	foldersOf?: (major: number) => string[];
	/** Where to copy data packs into for it: a folder of pack zips and folders (KubeJS's holds data files, not packs). */
	copyInto: string | null;
};

export const DATAPACK_LOADERS: DatapackLoader[] = [
	{
		ids: ['openloader'],
		name: 'Open Loader',
		file: /^open-?loader[-_]/i,
		folders: ['config/openloader/packs', 'config/openloader/data', 'openloader/data', 'datapacks'],
		// Open Loader 21 (the 1.21 line) moved to config/openloader/packs and the server's datapacks/.
		foldersOf: (major) => (major >= 21 ? ['config/openloader/packs', 'datapacks'] : ['config/openloader/data', 'openloader/data']),
		copyInto: 'config/openloader/packs'
	},
	{ ids: ['paxi'], name: 'Paxi', file: /^paxi[-_]/i, folders: ['config/paxi/datapacks'], copyInto: 'config/paxi/datapacks' },
	{
		ids: ['globalpacks', 'globaldataandresourcepacks'],
		name: 'Global Packs',
		file: /^global[-_ ]?(data)?packs?[-_]/i,
		folders: ['global_packs/required_data', 'global_packs/optional_data'],
		copyInto: 'global_packs/required_data'
	},
	{ ids: ['kubejs'], name: 'KubeJS', file: /^kubejs-(neoforge|forge|fabric|quilt)?[-_]?\d/i, folders: ['kubejs/data'], copyInto: null }
];

/** The mod's own version's first number, from a jar name: the last dotted version in it (OpenLoader-neoforge-1.21.1-21.1.4.jar is 21). */
function majorOf(fileName: string): number | null {
	const versions = fileName.replace(/\.jar(\.disabled)?$/i, '').match(/\d+(?:\.\d+)+/g);
	const major = versions ? Number(versions[versions.length - 1].split('.')[0]) : NaN;
	return Number.isFinite(major) ? major : null;
}

/** The folders this jar of the loader reads. */
function foldersRead(loader: DatapackLoader, fileName: string): string[] {
	const major = loader.foldersOf ? majorOf(fileName) : null;
	return loader.foldersOf && major !== null ? loader.foldersOf(major) : loader.folders;
}

export type LostDatapackLoader = {
	mod: string;
	/** The jar the change removes. */
	fileName: string;
	/** The user's own data packs it loaded (a zip or folder each), relative to the server folder. */
	packs: string[];
	/** Some of them add world generation. */
	worldgen: boolean;
	/**
	 * What reads data packs after the change: another loader the new version brings, or the
	 * same mod's new build, which reads another folder. Null when nothing does.
	 */
	takenOverBy: { mod: string; sameMod: boolean; folder: string | null } | null;
};

/**
 * The data pack loaders a pack change drops (`removed` from mods/) whose folders hold data
 * packs the installed version did not ship (`shipped`; null when that is not known, then all
 * count): gone with nothing in their place, replaced by another loader (Open Loader by Paxi),
 * or by a build of the same mod that reads other folders (Open Loader 21). A newer build
 * reading the same folders is no loss.
 */
export async function lostDatapackLoaders(
	root: string,
	removed: string[],
	added: string[],
	shipped: ((rel: string) => boolean) | null
): Promise<LostDatapackLoader[]> {
	const out: LostDatapackLoader[] = [];
	const loaderOfName = (name: string) => DATAPACK_LOADERS.find((l) => l.file.test(name));
	for (const fileName of removed) {
		const ids = (await describeModJar(path.join(root, 'mods', fileName)))?.ids ?? [];
		const loader = DATAPACK_LOADERS.find((l) => (ids.length ? l.ids.some((id) => ids.includes(id)) : l.file.test(fileName)));
		if (!loader) continue;
		const newBuild = added.find((name) => loader.file.test(name));
		const read = foldersRead(loader, fileName);
		let folders = read;
		let takenOverBy: LostDatapackLoader['takenOverBy'] = null;
		if (newBuild) {
			// The same mod: only folders the new build stops reading are lost.
			const still = foldersRead(loader, newBuild);
			folders = read.filter((f) => !still.includes(f));
			takenOverBy = { mod: loader.name, sameMod: true, folder: still.includes(loader.copyInto ?? '') ? loader.copyInto : (still[0] ?? null) };
		} else {
			const other = added.map(loaderOfName).find((l) => l && l !== loader);
			if (other) takenOverBy = { mod: other.name, sameMod: false, folder: other.copyInto };
		}
		const packs: string[] = [];
		let worldgen = false;
		for (const folder of folders) {
			for (const entry of await fs.readdir(path.join(root, folder), { withFileTypes: true }).catch(() => [])) {
				const rel = `${folder}/${entry.name}`;
				if (entry.isFile() && !/\.zip$/i.test(entry.name)) continue;
				if (shipped && (await shippedWhole(root, rel, entry.isDirectory(), shipped))) continue;
				packs.push(rel);
				worldgen ||= await changesWorldgen(path.join(root, rel), entry.isDirectory());
			}
		}
		if (packs.length) out.push({ mod: loader.name, fileName, packs, worldgen, takenOverBy });
	}
	return out;
}

/**
 * After a pack change: the lost loaders' data packs copied into the folder the loader that
 * took over reads. Copied, not moved: the old folder is read by nothing, and a copy cannot
 * lose a pack. One of the same name there already is left as it is. Returns what to report.
 */
export async function copyLostDatapacks(root: string, lost: LostDatapackLoader[]): Promise<{ copied: string[]; skipped: string[] }> {
	const copied: string[] = [];
	const skipped: string[] = [];
	for (const loader of lost) {
		const into = loader.takenOverBy?.folder;
		if (!into) continue;
		await fs.mkdir(path.join(root, into), { recursive: true });
		for (const rel of loader.packs) {
			const to = `${into}/${path.basename(rel)}`;
			if (await fs.stat(path.join(root, to)).catch(() => null)) {
				skipped.push(to);
				continue;
			}
			await fs.cp(path.join(root, rel), path.join(root, to), { recursive: true, preserveTimestamps: true });
			copied.push(to);
		}
	}
	return { copied, skipped };
}
export type LoaderDatapack = {
	fileName: string;
	/** Relative to the server folder. */
	path: string;
	sizeBytes: number;
	worldgen: boolean;
};

/** A folder a data pack loader on the server reads, for every world. */
export type LoaderDatapackFolder = { mod: string; folder: string; packs: LoaderDatapack[] };

/**
 * The folders the server's enabled data pack loaders read (their build's, foldersRead), with
 * the data packs in them: the Data packs tab lists these beside the world's own and uploads
 * into them. KubeJS is left out: its folder holds data files, not data packs.
 */
export async function loaderDatapackFolders(root: string): Promise<LoaderDatapackFolder[]> {
	const jars = (await indexMods(path.join(root, 'mods'))).filter((j) => j.enabled);
	const out: LoaderDatapackFolder[] = [];
	for (const loader of DATAPACK_LOADERS.filter((l) => l.copyInto)) {
		const jar = jars.find((j) => (j.ids.length ? loader.ids.some((id) => j.ids.includes(id)) : loader.file.test(j.fileName)));
		if (!jar) continue;
		for (const folder of foldersRead(loader, jar.fileName)) {
			const packs: LoaderDatapack[] = [];
			for (const entry of await fs.readdir(path.join(root, folder), { withFileTypes: true }).catch(() => [])) {
				if (!entry.isDirectory() && !/\.zip$/i.test(entry.name)) continue;
				const full = path.join(root, folder, entry.name);
				const stat = await fs.stat(full).catch(() => null);
				packs.push({
					fileName: entry.name,
					path: `${folder}/${entry.name}`,
					sizeBytes: stat?.isFile() ? stat.size : 0,
					worldgen: await changesWorldgen(full, entry.isDirectory())
				});
			}
			packs.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }));
			out.push({ mod: loader.name, folder, packs });
		}
	}
	return out;
}

/** Every file of it came with the installed version: the pack's, not the user's. */
async function shippedWhole(root: string, rel: string, isDirectory: boolean, shipped: (rel: string) => boolean): Promise<boolean> {
	if (!isDirectory) return shipped(rel);
	const names = (await fs.readdir(path.join(root, rel), { recursive: true, withFileTypes: true }).catch(() => [])).filter((e) => e.isFile());
	return names.length > 0 && names.every((e) => shipped(path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join('/')));
}
