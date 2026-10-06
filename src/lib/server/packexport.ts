import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import type { ServerInstance } from './db/schema';
import { TMP_DIR } from './config';
import { downloadFile, hashFile } from './download';
import { getProvider, listInstanceMods, DISABLED_SUFFIX } from './mods';
import { versionsFromHashes } from './mods/modrinth';
import { packVersionFiles } from './mods/modpacksch';
import { serverWorldName } from './packworld';
import { readForgeBackup } from './instances';
import { openZipBuffer, type ZipArchive } from './zip';
import { startTask, getTask, type TaskHandle } from './tasks';

/**
 * A pack players import into their launcher, built from a server: Modrinth
 * (.mrpack), CurseForge (.zip with manifest.json) or a Prism Launcher instance.
 *
 * What goes in: the mods ticked on the export form (each mod as it is on the
 * server, except client-only ones, which come back enabled), the folders
 * ticked (configs, scripts and so on), and for a server installed from a
 * provider pack also the pack's client-side files MineShell never put on the
 * server (client-only mods, client overrides like shaders or options.txt).
 *
 * Mods are linked where the format can: Modrinth files by their CDN URL in a
 * .mrpack, CurseForge files by project and file id in a CurseForge pack. The
 * rest is bundled as files in the pack's overrides. A Prism instance bundles
 * everything.
 */

export type ExportFormat = 'mrpack' | 'curseforge' | 'prism';

export const FORMATS: { id: ExportFormat; label: string; extension: string }[] = [
	{ id: 'mrpack', label: 'Modrinth (.mrpack)', extension: 'mrpack' },
	{ id: 'curseforge', label: 'CurseForge (.zip)', extension: 'zip' },
	{ id: 'prism', label: 'Prism Launcher instance (.zip)', extension: 'zip' }
];

export type ExportMod = {
	/** File name in mods/, as on the server (may end in .disabled). */
	file: string;
	name: string;
	/** Enabled in the export: as on the server, except client-only mods, which the client needs. */
	enabled: boolean;
	clientOnly: boolean;
	sizeBytes: number;
};

export type ExportFolder = { name: string; dir: boolean; include: boolean };

export type ExportPlan = {
	mods: ExportMod[];
	folders: ExportFolder[];
	/** A provider pack whose client-side files are added. */
	pack: { name: string; version: string | null } | null;
	defaultName: string;
	defaultVersion: string;
	/** Why a format cannot carry this server's loader exactly, per format. */
	loaderNotes: Partial<Record<ExportFormat, string>>;
};

/** Top-level entries that are the server's own, never offered. */
const NEVER = new Set([
	'mods',
	'logs',
	'crash-reports',
	'libraries',
	'versions',
	'.mineshell',
	'old-configs',
	'.fabric',
	'.quilt',
	'.cache',
	'debug',
	'server.properties',
	'eula.txt',
	'ops.json',
	'whitelist.json',
	'banned-players.json',
	'banned-ips.json',
	'usercache.json',
	'usernamecache.json',
	'run.sh',
	'run.bat',
	'user_jvm_args.txt',
	'server-icon.png',
	'installer.log'
]);

/** Ticked by default: what a client uses from a pack. */
const CLIENT_FOLDERS = new Set([
	'config',
	'defaultconfigs',
	'kubejs',
	'scripts',
	'resources',
	'resourcepacks',
	'shaderpacks',
	'global_packs',
	'patchouli_books',
	'openloader',
	'options.txt'
]);

const neverOffered = (name: string) =>
	NEVER.has(name) || /\.jar$/i.test(name) || /\.log$/i.test(name) || name.endsWith('.part');

/** Hosts a .mrpack may download from (Modrinth's format spec); anything else is bundled. */
const MRPACK_HOSTS = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);
const mrpackLinkable = (url: string) => {
	try {
		return MRPACK_HOSTS.has(new URL(url).hostname);
	} catch {
		return false;
	}
};

type Hashes = { sha1: string; sha512: string; size: number };
const hashCache = new Map<string, Hashes>();

async function hashes(file: string): Promise<Hashes> {
	const stat = await fs.stat(file);
	const key = `${file}:${stat.size}:${stat.mtimeMs}`;
	const cached = hashCache.get(key);
	if (cached) return cached;
	const result = { sha1: await hashFile(file, 'sha1'), sha512: await hashFile(file, 'sha512'), size: stat.size };
	hashCache.set(key, result);
	return result;
}

const providerPack = (instance: ServerInstance) =>
	instance.packSource && ['modrinth', 'curseforge', 'ftb'].includes(instance.packSource) && instance.packProjectId && instance.packVersionId
		? { source: instance.packSource as 'modrinth' | 'curseforge' | 'ftb', projectId: instance.packProjectId, versionId: instance.packVersionId }
		: null;

async function worldFolders(instance: ServerInstance): Promise<Set<string>> {
	const world = (await serverWorldName(instance.path)).split('/')[0];
	return new Set([world, `${world}_nether`, `${world}_the_end`]);
}

export async function planExport(instance: ServerInstance): Promise<ExportPlan> {
	// Every mod, server-only ones too: they do nothing on a client, but a singleplayer
	// test world then plays like the server.
	const rows = (await listInstanceMods(instance)).filter((m) => !m.missing);
	const mods: ExportMod[] = rows.map((m) => ({
		file: m.fileName,
		name: m.name,
		enabled: m.enabled || m.clientOnly,
		clientOnly: m.clientOnly,
		sizeBytes: m.sizeBytes
	}));

	const worlds = await worldFolders(instance);
	const folders: ExportFolder[] = (await fs.readdir(instance.path, { withFileTypes: true }))
		.filter((e) => !neverOffered(e.name) && !worlds.has(e.name) && (e.isDirectory() || e.isFile()))
		.map((e) => ({ name: e.name, dir: e.isDirectory(), include: CLIENT_FOLDERS.has(e.name) }))
		.sort((a, b) => Number(b.include) - Number(a.include) || a.name.localeCompare(b.name));

	const loaderNotes: ExportPlan['loaderNotes'] = {};
	if (instance.modloader === 'cleanroom') {
		const note =
			'This format has no Cleanroom: the pack asks for Forge 1.12.2, and Cleanroom-only mods (Fugue, Scalar) will not load on it. Use the Prism instance for Cleanroom.';
		loaderNotes.mrpack = note;
		loaderNotes.curseforge = note;
	}

	const pack = providerPack(instance);
	return {
		mods,
		folders,
		pack: pack ? { name: instance.packName ?? instance.name, version: instance.packVersionName } : null,
		defaultName: instance.packName ?? instance.name,
		defaultVersion: instance.packVersionName ?? new Date().toISOString().slice(0, 10),
		loaderNotes
	};
}

// ------------------------------------------------------------------ build ---

export type ExportChoices = {
	format: ExportFormat;
	name: string;
	version: string;
	/** File names in mods/ to include. */
	mods: string[];
	/** Top-level entries to include. */
	folders: string[];
};

/** One file in the pack, by its path inside the game folder (e.g. mods/foo.jar). */
type Entry = {
	path: string;
	/** Where its bytes come from when bundled: a file here, a URL, or an entry of an archive. */
	from: { file: string } | { url: string; sha1?: string | null } | { zip: ZipArchive; entry: string };
	modrinth?: { url: string; sha1: string; sha512: string; size: number; clientOnly: boolean };
	curseforge?: { projectId: number; fileId: number };
};

async function listFiles(root: string, rel: string, out: string[]): Promise<void> {
	const abs = path.join(root, rel);
	const stat = await fs.lstat(abs);
	if (stat.isSymbolicLink()) return;
	if (stat.isFile()) {
		out.push(rel.split(path.sep).join('/'));
		return;
	}
	if (!stat.isDirectory()) return;
	for (const child of await fs.readdir(abs)) await listFiles(root, path.join(rel, child), out);
}

/** The server's own files: ticked mods and folders. */
async function serverEntries(instance: ServerInstance, choices: ExportChoices, plan: ExportPlan): Promise<Entry[]> {
	const entries: Entry[] = [];
	const rows = new Map((await listInstanceMods(instance)).map((m) => [m.fileName, m]));
	const wanted = new Set(choices.mods);
	const modsDir = path.join(instance.path, 'mods');

	const byHash = new Map<string, { file: string; hashes: Hashes }>();
	for (const mod of plan.mods) {
		if (!wanted.has(mod.file)) continue;
		byHash.set(mod.file, { file: mod.file, hashes: await hashes(path.join(modsDir, mod.file)) });
	}
	const versions = await versionsFromHashes([...byHash.values()].map((h) => h.hashes.sha512), 'sha512');

	for (const mod of plan.mods) {
		const known = byHash.get(mod.file);
		if (!known) continue;
		const base = mod.file.endsWith(DISABLED_SUFFIX) ? mod.file.slice(0, -DISABLED_SUFFIX.length) : mod.file;
		const name = mod.enabled ? base : `${base}${DISABLED_SUFFIX}`;
		const entry: Entry = { path: `mods/${name}`, from: { file: path.join(modsDir, mod.file) } };
		const version = versions.get(known.hashes.sha512);
		const file = version?.files.find((f) => f.hash?.value === known.hashes.sha512);
		if (file) entry.modrinth = { url: file.url, ...known.hashes, clientOnly: mod.clientOnly };
		const row = rows.get(mod.file);
		if (row?.source === 'curseforge' && /^\d+$/.test(row.slug ?? '') && /^\d+$/.test(row.versionId ?? '')) {
			entry.curseforge = { projectId: Number(row.slug), fileId: Number(row.versionId) };
		}
		entries.push(entry);
	}

	const folders = new Set(choices.folders);
	for (const folder of plan.folders) {
		if (!folders.has(folder.name)) continue;
		const files: string[] = [];
		await listFiles(instance.path, folder.name, files);
		for (const rel of files) entries.push({ path: rel, from: { file: path.join(instance.path, rel) } });
	}
	return entries;
}

/**
 * The provider pack's client-side files that are not on the server: mods the
 * pack marks client-only (MineShell never downloads those) and override files
 * the server does not have (client overrides, or ones only a client uses).
 * A pack mod missing on the server that is not client-only was removed on
 * purpose and stays out; so does anything under a folder left unticked.
 */
async function packClientEntries(
	instance: ServerInstance,
	choices: ExportChoices,
	plan: ExportPlan,
	task: TaskHandle
): Promise<Entry[]> {
	const pack = providerPack(instance);
	if (!pack) return [];
	const onServer = new Set<string>();
	for (const mod of plan.mods) {
		const base = mod.file.endsWith(DISABLED_SUFFIX) ? mod.file.slice(0, -DISABLED_SUFFIX.length) : mod.file;
		onServer.add(`mods/${base}`);
	}
	const unticked = new Set(plan.folders.filter((f) => !choices.folders.includes(f.name)).map((f) => f.name));
	const exists = async (rel: string) =>
		fs.access(path.join(instance.path, rel)).then(
			() => true,
			() => false
		);
	const keepOverride = async (rel: string) =>
		!rel.split('/').includes('..') && !unticked.has(rel.split('/')[0]) && !rel.startsWith('mods/') && !(await exists(rel));

	const entries: Entry[] = [];
	task.setProgress(null, 'Reading the pack for its client files');

	if (pack.source === 'modrinth') {
		const version = await getProvider('modrinth').getVersion(pack.projectId, pack.versionId);
		const file = version.files.find((f) => f.primary) ?? version.files[0];
		if (!file) return [];
		const res = await fetch(file.url);
		if (!res.ok) throw new Error(`Could not download the pack (${res.status}).`);
		const zip = openZipBuffer(Buffer.from(await res.arrayBuffer()));
		const index = zip?.readText('modrinth.index.json');
		if (!zip || !index) throw new Error('The pack has no modrinth.index.json.');
		const parsed = JSON.parse(index) as {
			files: { path: string; hashes: { sha1?: string; sha512?: string }; downloads: string[]; fileSize?: number; env?: { client?: string; server?: string } }[];
		};
		for (const f of parsed.files) {
			if (f.env?.server !== 'unsupported' || f.env?.client === 'unsupported') continue;
			if (onServer.has(f.path) || (await exists(f.path))) continue;
			const url = f.downloads[0];
			if (!url) continue;
			entries.push({
				path: f.path,
				from: { url, sha1: f.hashes.sha1 ?? null },
				...(f.hashes.sha1 && f.hashes.sha512
					? { modrinth: { url, sha1: f.hashes.sha1, sha512: f.hashes.sha512, size: f.fileSize ?? 0, clientOnly: true } }
					: {})
			});
		}
		for (const e of zip.entries) {
			const m = /^(overrides|client-overrides)\/(.+[^/])$/.exec(e.name);
			if (m && (await keepOverride(m[2]))) entries.push({ path: m[2], from: { zip, entry: e.name } });
		}
		return entries;
	}

	const files = await packVersionFiles(pack.source, pack.projectId, pack.versionId);
	for (const f of files) {
		const dir = (f.path ?? '').replace(/^\.?\/*/, '').replace(/\/+$/, '');
		const rel = path.posix.join(dir, f.name);
		if (dir === '' && f.name.toLowerCase() === 'overrides.zip') {
			const temp = path.join(TMP_DIR, `export-overrides-${Date.now()}.zip`);
			try {
				await downloadFile(f.url, temp, { hash: f.sha1 ? { algo: 'sha1', value: f.sha1 } : null });
				const zip = openZipBuffer(await fs.readFile(temp));
				for (const e of zip?.entries ?? []) {
					const m = /^overrides\/(.+[^/])$/.exec(e.name);
					if (zip && m && (await keepOverride(m[1]))) entries.push({ path: m[1], from: { zip, entry: e.name } });
				}
			} finally {
				await fs.rm(temp, { force: true });
			}
			continue;
		}
		if (!f.clientonly || onServer.has(rel) || (await exists(rel)) || unticked.has(rel.split('/')[0])) continue;
		entries.push({
			path: rel,
			from: { url: f.url, sha1: f.sha1 ?? null },
			...(f.curseforge ? { curseforge: { projectId: Number(f.curseforge.project), fileId: Number(f.curseforge.file) } } : {})
		});
	}
	return entries;
}

async function loaderVersionFor(instance: ServerInstance): Promise<{ loader: string; version: string | null }> {
	if (instance.modloader !== 'cleanroom') return { loader: instance.modloader, version: instance.modloaderVersion };
	// The Forge it was migrated from, else the last Forge for 1.12.2.
	return { loader: 'forge', version: (await readForgeBackup(instance))?.modloaderVersion ?? '14.23.5.2860' };
}

const MRPACK_LOADER: Record<string, string> = {
	forge: 'forge',
	neoforge: 'neoforge',
	fabric: 'fabric-loader',
	quilt: 'quilt-loader'
};

const PRISM_LOADER: Record<string, string> = {
	forge: 'net.minecraftforge',
	neoforge: 'net.neoforged',
	fabric: 'net.fabricmc.fabric-loader',
	quilt: 'org.quiltmc.quilt-loader'
};

/** A Prism instance's components; Cleanroom's come from its own published instance. */
async function prismComponents(instance: ServerInstance, zip: yazl.ZipFile): Promise<string> {
	if (instance.modloader === 'cleanroom') {
		const version = instance.modloaderVersion ?? '';
		const url = `https://github.com/CleanroomMC/Cleanroom/releases/download/${version}/cleanroom-${version}.zip`;
		const res = await fetch(url);
		if (!res.ok) {
			throw new Error(
				`Cleanroom ${version} has no Prism instance published (${res.status}); one is published from 0.5.x on.`
			);
		}
		const published = openZipBuffer(Buffer.from(await res.arrayBuffer()));
		const pack = published?.readText('mmc-pack.json');
		if (!published || !pack) throw new Error(`Cleanroom ${version}'s Prism instance has no mmc-pack.json.`);
		for (const e of published.entries) {
			if (/^patches\/[^/]+\.json$/.test(e.name)) zip.addBuffer(published.readFile(e.name)!, e.name);
		}
		return pack;
	}
	const mc = instance.minecraftVersion;
	const components: Record<string, unknown>[] = [{ uid: 'net.minecraft', version: mc, important: true }];
	const uid = PRISM_LOADER[instance.modloader];
	if (instance.modloader === 'fabric' || instance.modloader === 'quilt') {
		components.push({ uid: 'net.fabricmc.intermediary', version: mc, dependencyOnly: true });
	}
	if (uid && instance.modloaderVersion) components.push({ uid, version: instance.modloaderVersion });
	return JSON.stringify({ formatVersion: 1, components }, null, 2);
}

function safeFileName(name: string): string {
	return name.replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '-') || 'pack';
}

type Built = { instanceId: string; file: string; fileName: string };
const built = new Map<string, Built>();
const EXPORT_DIR = path.join(TMP_DIR, 'exports');
const KEEP_MS = 60 * 60_000;

/** The finished export of a task, if it belongs to that server and is still kept. */
export function exportResult(instanceId: string, taskId: string): Built | null {
	const result = built.get(taskId);
	return result && result.instanceId === instanceId && getTask(taskId)?.state === 'done' ? result : null;
}

async function sweepExports(): Promise<void> {
	const cutoff = Date.now() - KEEP_MS;
	for (const entry of await fs.readdir(EXPORT_DIR).catch(() => [] as string[])) {
		const dir = path.join(EXPORT_DIR, entry);
		const stat = await fs.stat(dir).catch(() => null);
		if (stat && stat.mtimeMs < cutoff) {
			await fs.rm(dir, { recursive: true, force: true });
			built.delete(entry);
		}
	}
}

export async function buildExport(instance: ServerInstance, choices: ExportChoices, task: TaskHandle, outFile: string): Promise<void> {
	const plan = await planExport(instance);
	task.setProgress(null, 'Hashing mods');
	const entries = [...(await serverEntries(instance, choices, plan)), ...(await packClientEntries(instance, choices, plan, task))];

	const zip = new yazl.ZipFile();
	const temp = `${outFile}.parts`;
	await fs.mkdir(temp, { recursive: true });
	const root = choices.format === 'prism' ? '.minecraft' : 'overrides';
	const { loader, version: loaderVersion } = await loaderVersionFor(instance);

	const mrFiles: Record<string, unknown>[] = [];
	const cfFiles: { projectID: number; fileID: number; required: boolean }[] = [];
	const seen = new Set<string>();
	let downloaded = 0;

	try {
		for (const [i, entry] of entries.entries()) {
			if (seen.has(entry.path)) continue;
			seen.add(entry.path);
			task.setProgress((i / entries.length) * 100, `Adding ${entry.path}`);
			const disabled = entry.path.endsWith(DISABLED_SUFFIX);

			if (choices.format === 'mrpack' && entry.modrinth && mrpackLinkable(entry.modrinth.url)) {
				mrFiles.push({
					path: entry.path,
					hashes: { sha1: entry.modrinth.sha1, sha512: entry.modrinth.sha512 },
					env: { client: 'required', server: entry.modrinth.clientOnly ? 'unsupported' : 'required' },
					downloads: [entry.modrinth.url],
					fileSize: entry.modrinth.size
				});
				continue;
			}
			// A disabled mod is bundled as its .disabled file: a CurseForge manifest cannot say "disabled".
			if (choices.format === 'curseforge' && entry.curseforge && !disabled) {
				cfFiles.push({ projectID: entry.curseforge.projectId, fileID: entry.curseforge.fileId, required: true });
				continue;
			}

			const target = `${root}/${entry.path}`;
			if ('file' in entry.from) zip.addFile(entry.from.file, target);
			else if ('zip' in entry.from) zip.addBuffer(entry.from.zip.readFile(entry.from.entry) ?? Buffer.alloc(0), target);
			else {
				const file = path.join(temp, String(++downloaded));
				task.log(`Downloading ${entry.path}`);
				await downloadFile(entry.from.url, file, { hash: entry.from.sha1 ? { algo: 'sha1', value: entry.from.sha1 } : null });
				zip.addFile(file, target);
			}
		}

		if (choices.format === 'mrpack') {
			const dependencies: Record<string, string> = { minecraft: instance.minecraftVersion };
			if (MRPACK_LOADER[loader] && loaderVersion) dependencies[MRPACK_LOADER[loader]] = loaderVersion;
			const index = { formatVersion: 1, game: 'minecraft', versionId: choices.version, name: choices.name, files: mrFiles, dependencies };
			zip.addBuffer(Buffer.from(JSON.stringify(index, null, 2)), 'modrinth.index.json');
		} else if (choices.format === 'curseforge') {
			const manifest = {
				minecraft: {
					version: instance.minecraftVersion,
					modLoaders: MRPACK_LOADER[loader] && loaderVersion ? [{ id: `${loader}-${loaderVersion}`, primary: true }] : []
				},
				manifestType: 'minecraftModpack',
				manifestVersion: 1,
				name: choices.name,
				version: choices.version,
				author: '',
				files: cfFiles,
				overrides: 'overrides'
			};
			zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
		} else {
			zip.addBuffer(Buffer.from(await prismComponents(instance, zip)), 'mmc-pack.json');
			zip.addBuffer(Buffer.from(`InstanceType=OneSix\nname=${choices.name.replace(/[\r\n]/g, ' ')}\n`), 'instance.cfg');
		}

		task.setProgress(99, 'Writing the pack');
		zip.end();
		await pipeline(zip.outputStream, createWriteStream(outFile));
		task.log(
			choices.format === 'prism'
				? `${seen.size} files bundled.`
				: `${mrFiles.length + cfFiles.length} files linked, ${seen.size - mrFiles.length - cfFiles.length} bundled.`
		);
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
}

export async function startExport(instance: ServerInstance, choices: ExportChoices): Promise<string> {
	await sweepExports();
	const format = FORMATS.find((f) => f.id === choices.format) ?? FORMATS[0];
	const fileName = `${safeFileName(choices.name)}-${safeFileName(choices.version)}${choices.format === 'prism' ? '-prism' : ''}.${format.extension}`;
	return startTask({ label: `Export ${instance.name} as ${format.label.replace(/ \(.*\)$/, '')}`, instanceId: instance.id }, async (task) => {
		const dir = path.join(EXPORT_DIR, task.id);
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, fileName);
		await buildExport(instance, choices, task, file);
		built.set(task.id, { instanceId: instance.id, file, fileName });
	});
}
