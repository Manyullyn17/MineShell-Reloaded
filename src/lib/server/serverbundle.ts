import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, eq } from 'drizzle-orm';
import yazl from 'yazl';
import { db } from './db';
import { instanceDatapacks, instanceMods, instanceTags, mods, serverInstances, serverTags, type ServerInstance } from './db/schema';
import { TMP_DIR } from './config';
import { hashFile } from './download';
import { BACKUP_MOD_FOLDERS, MAP_MOD_FOLDERS } from './diskusage';
import { safeJoin } from './files';
import {
	audit,
	cloneSkips,
	endJournalOnFailure,
	eulaIsAccepted,
	acceptEula,
	insertInstanceRow,
	InstanceError,
	isLoaderInstallEntry,
	javaTarget,
	listInstances,
	obtainJava,
	planJava,
	rconPassword,
	requireInstance,
	startWhenInstalled,
	summarise,
	syncUnit,
	watchTaskFailure
} from './instances';
import { getLoader } from './modloaders';
import { DISABLED_SUFFIX } from './mods';
import { versionsFromHashes } from './mods/modrinth';
import { downloadPackFiles, type PackDownload } from './packs';
import { recordMissing, missingNotice } from './packs/missing';
import { patchProperties } from './properties';
import { rconExec } from './rcon';
import { commitOperation } from './operations';
import { getMacros, setMacros } from './macros';
import { addCustomField, listCustomFields } from './playerfields';
import { addScheduledCommand, listScheduledCommands, setScheduledCommandEnabled } from './scheduledcommands';
import { saveServerSnapshotOverrides, serverSnapshotOverrides } from './snapshots';
import { getSnapshotSchedule, saveSnapshotSchedule, validSchedule } from './snapshotschedule';
import { assignServerTag, createOrFindServerTag } from './servertags';
import { claimVoicePort } from './voicechat';
import { foldersOfWorld, worldFolderNames } from './worlds';
import { entryStream, openZip, STORED, zipEntries } from './world';
import { startTask, getTask, type TaskHandle } from './tasks';
import type { CreateInstanceInput } from './instances';
import type { JavaVendor } from './javadownload';

/**
 * A server moved to another MineShell (ROADMAP-ARCHIVE, "Instance export and
 * import"): one zip with `mineshell-export.json` and the server's files under
 * `files/`. Like a modpack, a mod MineShell can download again is not in it:
 * Modrinth files (found by their hash) and CurseForge ones (by project and
 * file id) are listed in the manifest and fetched on import; everything else
 * is carried as files. The loader is not carried either: the import installs
 * the same version, so its libraries and jars stay out (isLoaderInstallEntry).
 *
 * Along with the files go the server's settings and its MineShell records
 * (mod sources, scheduled commands, macros, player fields, data pack sources,
 * snapshot policy and schedule, tags). What belongs to the machine stays:
 * ports, the RCON password, the Java path, accounts' access, playit tunnels,
 * notification destinations (they hold webhook URLs), run history.
 */

export const BUNDLE_FORMAT = 1;
export const MANIFEST = 'mineshell-export.json';
const FILES = 'files/';

export type BundleChoices = {
	/** Every world of the server, the active one and the others. */
	worlds: boolean;
	snapshots: boolean;
	/** logs/ and crash-reports/. */
	logs: boolean;
	/** A map mod's own tiles (Dynmap, the BlueMap mod). */
	mapTiles: boolean;
	/** A backup mod's own world copies (AromaBackup, FTB Utilities, Simple Backups). */
	modBackups: boolean;
};

type ModRecord = {
	filePath: string;
	source: string;
	slug: string;
	name: string;
	author: string | null;
	summary: string | null;
	projectUrl: string | null;
	iconUrl: string | null;
	version: string | null;
	versionId: string | null;
	hash: string | null;
	hashAlgo: string | null;
	enabled: boolean;
	fromPack: boolean;
	locked: boolean;
	clientOnly: boolean;
	flags: string | null;
};

type DatapackRecord = {
	source: string;
	projectId: string;
	slug: string;
	name: string;
	projectUrl: string | null;
	iconUrl: string | null;
	version: string | null;
	versionId: string | null;
	fileName: string;
	hash: string | null;
};

export type BundleManifest = {
	format: number;
	mineshell: string;
	exportedAt: number;
	server: {
		name: string;
		minecraftVersion: string;
		modloader: string;
		modloaderVersion: string | null;
		pack: { source: string | null; projectId: string | null; versionId: string | null; versionName: string | null; name: string | null; datapacks: string | null };
		settings: Record<string, unknown>;
	};
	included: BundleChoices;
	/** Files fetched again on import, by where they go in the server folder. */
	downloads: (PackDownload & { size: number })[];
	/** Files carried under files/, and their size before compression. */
	files: number;
	bytes: number;
	records: {
		mods: ModRecord[];
		scheduledCommands: { command: string; everyMinutes: number | null; dailyTime: string | null; enabled: boolean }[];
		macros: string[];
		playerFields: { label: string; kind: string; path: unknown }[];
		datapacks: DatapackRecord[];
		snapshotPolicy: Record<string, unknown>;
		snapshotSchedule: Record<string, unknown> | null;
		tags: string[];
	};
};

// ---------------------------------------------------------------- settings ---

type Rule = (value: unknown) => unknown;
const int = (min: number, max: number): Rule => (v) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const intOrNull = (min: number, max: number): Rule => (v) => (v === null ? null : int(min, max)(v));
const bool: Rule = (v) => (typeof v === 'boolean' ? v : undefined);
const oneOf = (...values: string[]): Rule => (v) => (typeof v === 'string' && values.includes(v) ? v : undefined);
const text = (max: number, nullable = false): Rule => (v) =>
	v === null && nullable ? null : typeof v === 'string' && v.length <= max && !/[\r\n\0]/.test(v) ? v : undefined;
const notes: Rule = (v) => (v === null ? null : typeof v === 'string' && v.length <= 20_000 ? v : undefined);
const clock: Rule = (v) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined);

/**
 * The server's own settings that travel, each checked on import as a settings
 * page would; a value that fails keeps what a new server gets. Ports, Java,
 * the launch command (the loader install writes it) and status do not travel.
 */
const SETTINGS: Record<string, Rule> = {
	memoryMaxMb: int(256, 1_048_576),
	memoryMinMb: int(128, 1_048_576),
	jvmArgs: text(8000),
	restartSchedule: oneOf('none', 'interval', 'daily'),
	restartIntervalHours: int(1, 24 * 7),
	restartDailyTime: clock,
	restartWarnMinutes: int(0, 60),
	restartSkipIfPlayers: bool,
	autoRestartOnCrash: bool,
	crashRestartLimit: int(1, 100),
	crashRestartWindowSec: int(10, 86_400),
	bootStart: oneOf('if-running', 'always', 'never'),
	limitMemoryMb: intOrNull(256, 1_048_576),
	limitCpuPercent: intOrNull(1, 100_000),
	consoleBacklogLines: int(10, 1_000_000),
	consoleBufferLines: int(10, 1_000_000),
	updateCheck: bool,
	updateCheckHours: int(1, 24 * 60),
	updateChannel: oneOf('release', 'beta', 'alpha'),
	modUpdateCheck: bool,
	notes
};

export function checkedSettings(raw: unknown): Partial<ServerInstance> {
	const out: Record<string, unknown> = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const [key, rule] of Object.entries(SETTINGS)) {
		const value = rule((raw as Record<string, unknown>)[key]);
		if (value !== undefined) out[key] = value;
	}
	if (typeof out.memoryMinMb === 'number' && typeof out.memoryMaxMb === 'number' && out.memoryMinMb > out.memoryMaxMb) delete out.memoryMinMb;
	return out as Partial<ServerInstance>;
}

// ------------------------------------------------------------------ export ---

/** Where a file of the server folder goes in an export: left out, a choice, or always. */
export function bundleCategory(rel: string, worldTops: Set<string>): keyof BundleChoices | 'never' | 'always' {
	const parts = rel.split('/');
	const top = parts[0];
	const name = parts[parts.length - 1];
	if (name === 'session.lock' || rel === 'eula.txt') return 'never';
	if (rel.startsWith('.mineshell/snapshots/') || rel === '.mineshell/snapshots') return 'snapshots';
	for (let i = 1; i <= parts.length; i++) if (cloneSkips(parts.slice(0, i).join('/'))) return 'never';
	// The import installs the loader again. More comes back by itself: the vanilla jar
	// Fabric's install caches (.fabric-cache), what the vanilla server unpacks on its first
	// start (versions/) and Quilt's remapped game jars, one set per loader and Minecraft
	// version it ever ran (.cache/quilt_loader, tens of MB each).
	if (isLoaderInstallEntry(top) || top === '.fabric-cache' || top === 'versions') return 'never';
	if (parts[0] === '.cache' && parts[1] === 'quilt_loader') return 'never';
	if (worldTops.has(top)) return 'worlds';
	if (top === 'logs' || top === 'crash-reports') return 'logs';
	if (top in MAP_MOD_FOLDERS) return 'mapTiles';
	if (top in BACKUP_MOD_FOLDERS) return 'modBackups';
	return 'always';
}

async function worldTopFolders(root: string): Promise<Set<string>> {
	const tops = new Set<string>();
	for (const world of await worldFolderNames(root)) {
		for (const folder of await foldersOfWorld(root, world)) tops.add(folder.split('/')[0]);
		tops.add(world.split('/')[0]);
	}
	return tops;
}

async function listFiles(root: string, rel: string, out: string[]): Promise<void> {
	const stat = await fs.lstat(path.join(root, rel)).catch(() => null);
	if (!stat || stat.isSymbolicLink()) return;
	if (stat.isFile()) out.push(rel.split(path.sep).join('/'));
	else if (stat.isDirectory()) for (const child of await fs.readdir(path.join(root, rel))) await listFiles(root, rel ? path.join(rel, child) : child, out);
}

/** A mod jar MineShell can fetch again: from Modrinth by its hash, from CurseForge by its row's ids. */
async function linkedMods(instance: ServerInstance, jars: string[], task: TaskHandle): Promise<Map<string, PackDownload & { size: number }>> {
	const linked = new Map<string, PackDownload & { size: number }>();
	const rows = new Map(
		db
			.select({ filePath: instanceMods.filePath, source: mods.source, slug: mods.slug, versionId: instanceMods.versionId })
			.from(instanceMods)
			.innerJoin(mods, eq(mods.id, instanceMods.modId))
			.where(eq(instanceMods.instanceId, instance.id))
			.all()
			.map((r) => [r.filePath.split(path.sep).join('/'), r])
	);
	const hashes = new Map<string, { sha512: string; size: number }>();
	for (const [i, rel] of jars.entries()) {
		task.setProgress((i / Math.max(jars.length, 1)) * 30, 'Looking up mods');
		const file = path.join(instance.path, rel);
		hashes.set(rel, { sha512: await hashFile(file, 'sha512'), size: (await fs.stat(file)).size });
	}
	// Modrinth not answering finds nothing: those mods are carried as files instead.
	const versions = await versionsFromHashes([...hashes.values()].map((h) => h.sha512), 'sha512');
	for (const rel of jars) {
		const { sha512, size } = hashes.get(rel)!;
		const file = versions.get(sha512)?.files.find((f) => f.hash?.value === sha512);
		if (file?.url) {
			linked.set(rel, { target: rel, urls: [file.url], hash: { algo: 'sha512', value: sha512 }, required: true, size });
			continue;
		}
		const row = rows.get(rel);
		if (row?.source === 'curseforge' && /^\d+$/.test(row.slug) && /^\d+$/.test(row.versionId ?? '')) {
			// Resolved to its URL and hash when imported (downloadPackFiles), with the CDN as a fallback.
			linked.set(rel, { target: rel, urls: [], hash: null, curseforge: { projectId: Number(row.slug), fileId: Number(row.versionId) }, required: true, size });
		}
	}
	return linked;
}

function records(instance: ServerInstance): BundleManifest['records'] {
	const modRows = db
		.select()
		.from(instanceMods)
		.innerJoin(mods, eq(mods.id, instanceMods.modId))
		.where(eq(instanceMods.instanceId, instance.id))
		.all()
		.map(({ instance_mods: im, mods: m }) => ({
			filePath: im.filePath.split(path.sep).join('/'),
			source: m.source,
			slug: m.slug,
			name: m.name,
			author: m.author,
			summary: m.summary,
			projectUrl: m.projectUrl,
			iconUrl: m.iconUrl,
			version: im.version,
			versionId: im.versionId,
			hash: im.hash,
			hashAlgo: im.hashAlgo,
			enabled: im.enabled,
			fromPack: im.fromPack,
			locked: im.locked,
			clientOnly: im.clientOnly,
			flags: im.flags
		}));
	const datapacks = db
		.select()
		.from(instanceDatapacks)
		.where(eq(instanceDatapacks.instanceId, instance.id))
		.all()
		.map(({ id: _id, instanceId: _instance, installedAt: _at, ...row }) => row);
	const tags = db
		.select({ name: serverTags.name })
		.from(instanceTags)
		.innerJoin(serverTags, eq(serverTags.id, instanceTags.tagId))
		.where(eq(instanceTags.instanceId, instance.id))
		.all()
		.map((t) => t.name);
	return {
		mods: modRows,
		scheduledCommands: listScheduledCommands(instance.id).map((c) => ({ command: c.command, everyMinutes: c.everyMinutes, dailyTime: c.dailyTime, enabled: c.enabled })),
		macros: getMacros(instance.id),
		playerFields: listCustomFields(instance.id).map((f) => ({ label: f.label, kind: f.kind, path: f.path })),
		datapacks,
		snapshotPolicy: serverSnapshotOverrides(instance.id),
		snapshotSchedule: getSnapshotSchedule(instance.id),
		tags
	};
}

function settingsOf(instance: ServerInstance): Record<string, unknown> {
	const row = instance as unknown as Record<string, unknown>;
	return Object.fromEntries(Object.keys(SETTINGS).map((key) => [key, row[key]]));
}

/** Pauses saving on a running server while its world is read; `resume` is safe to call twice. */
async function pauseSaving(instance: ServerInstance, task: TaskHandle): Promise<() => Promise<void>> {
	if (!(await summarise(instance)).running) return async () => undefined;
	const password = rconPassword(instance);
	if (!password) throw new InstanceError('RCON is not set up for this server; stop it to export it with its world.');
	const rcon = (commands: string[]) => rconExec({ port: instance.rconPort, password }, commands);
	try {
		await rcon(['save-off', 'save-all flush']);
	} catch {
		throw new InstanceError('The server did not answer over RCON, so saving could not be paused. Stop it to export it with its world.');
	}
	task.log('Saving is paused while the world is copied.');
	let resumed = false;
	return async () => {
		if (resumed) return;
		resumed = true;
		await rcon(['save-on']).catch(() => task.log('Saving could not be turned back on: run "save-on" in the console.'));
	};
}

type Built = { instanceId: string; file: string; fileName: string };
const built = new Map<string, Built>();
const EXPORT_DIR = () => path.join(TMP_DIR, 'server-exports');
const KEEP_MS = 60 * 60_000;

/** A finished server export (by its task), if it is this server's and still kept. */
export function serverExportResult(instanceId: string, taskId: string): Built | null {
	const result = built.get(taskId);
	return result && result.instanceId === instanceId && getTask(taskId)?.state === 'done' ? result : null;
}

async function sweep(): Promise<void> {
	const cutoff = Date.now() - KEEP_MS;
	for (const entry of await fs.readdir(EXPORT_DIR()).catch(() => [] as string[])) {
		const dir = path.join(EXPORT_DIR(), entry);
		const stat = await fs.stat(dir).catch(() => null);
		if (stat && stat.mtimeMs < cutoff) {
			await fs.rm(dir, { recursive: true, force: true });
			built.delete(entry);
		}
	}
}

const safeFileName = (name: string) => name.replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '-') || 'server';

export async function buildServerExport(instance: ServerInstance, choices: BundleChoices, task: TaskHandle, outFile: string): Promise<BundleManifest> {
	task.setProgress(null, 'Listing files');
	const all: string[] = [];
	await listFiles(instance.path, '', all);
	const tops = await worldTopFolders(instance.path);
	const included = all.filter((rel) => {
		const category = bundleCategory(rel, tops);
		return category === 'always' || (category !== 'never' && choices[category]);
	});
	const jars = included.filter((rel) => /^mods\/[^/]+\.jar(\.disabled)?$/i.test(rel));
	const linked = await linkedMods(instance, jars, task);
	const carried = included.filter((rel) => !linked.has(rel));

	let bytes = 0;
	for (const rel of carried) bytes += (await fs.stat(path.join(instance.path, rel))).size;
	const free = await fs.statfs(path.dirname(outFile)).then((s) => s.bavail * s.bsize).catch(() => Infinity);
	if (bytes + 1024 ** 3 > free) {
		throw new InstanceError(
			`The export needs up to ${Math.ceil(bytes / 1024 ** 2)} MB and the disk has ${Math.floor(free / 1024 ** 2)} MB free (less 1 GB kept spare).`
		);
	}

	const manifest: BundleManifest = {
		format: BUNDLE_FORMAT,
		mineshell: __MINESHELL_VERSION__,
		exportedAt: Date.now(),
		server: {
			name: instance.name,
			minecraftVersion: instance.minecraftVersion,
			modloader: instance.modloader,
			modloaderVersion: instance.modloaderVersion,
			pack: {
				source: instance.packSource,
				projectId: instance.packProjectId,
				versionId: instance.packVersionId,
				versionName: instance.packVersionName,
				name: instance.packName,
				datapacks: instance.packDatapacks
			},
			settings: settingsOf(instance)
		},
		included: choices,
		downloads: [...linked.values()],
		files: carried.length,
		bytes,
		records: records(instance)
	};

	const resume = choices.worlds ? await pauseSaving(instance, task) : async () => undefined;
	try {
		const zip = new yazl.ZipFile();
		zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 1)), MANIFEST);
		for (const rel of carried) zip.addFile(path.join(instance.path, rel), FILES + rel, { compress: !STORED.test(rel) && !/\.jar$/i.test(rel) });
		zip.end();
		let written = 0;
		zip.outputStream.on('data', (chunk: Buffer) => {
			written += chunk.length;
			task.setProgress(30 + Math.min(69, (written / Math.max(bytes, 1)) * 69), 'Writing the export');
		});
		await pipeline(zip.outputStream, createWriteStream(outFile));
	} finally {
		await resume();
	}
	task.log(`${carried.length} files carried, ${linked.size} mods to download again on import.`);
	return manifest;
}

export async function startServerExport(instance: ServerInstance, choices: BundleChoices): Promise<string> {
	await sweep();
	const stamp = new Date().toISOString().slice(0, 10);
	const fileName = `${safeFileName(instance.name)}-${stamp}.mineshell.zip`;
	return startTask({ label: `Export ${instance.name} for another MineShell`, instanceId: instance.id }, async (task) => {
		const dir = path.join(EXPORT_DIR(), task.id);
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, fileName);
		try {
			await buildServerExport(instance, choices, task, file);
		} catch (err) {
			await fs.rm(dir, { recursive: true, force: true });
			throw err;
		}
		built.set(task.id, { instanceId: instance.id, file, fileName });
		audit('instance.exported', { instanceId: instance.id });
	});
}

// ------------------------------------------------------------------ import ---

export type ImportPreview = {
	id: string;
	fileName: string;
	sizeBytes: number;
	name: string;
	minecraftVersion: string;
	modloader: string;
	modloaderVersion: string | null;
	pack: string | null;
	mineshell: string;
	exportedAt: number;
	mods: number;
	downloads: number;
	included: BundleChoices;
	/** server-icon.png as a data URL, null without one. */
	icon: string | null;
};

type Staged = { file: string; fileName: string; owned: boolean; manifest: BundleManifest; icon: string | null; at: number };
const staged = new Map<string, Staged>();
const STAGE_KEEP_MS = 2 * 60 * 60_000;
export const IMPORT_DIR = () => path.join(TMP_DIR, 'imports');

/** The manifest of an export file; throws an InstanceError for anything else. */
export async function readManifest(file: string): Promise<BundleManifest> {
	return (await readBundle(file)).manifest;
}

const ICON_ENTRY = `${FILES}server-icon.png`;
/** Larger than any server icon (64x64); a bigger file is not shown in the preview. */
const ICON_MAX_BYTES = 256 * 1024;

/** The manifest, and the server's icon as a data URL for the import preview. */
async function readBundle(file: string): Promise<{ manifest: BundleManifest; icon: string | null }> {
	let text: string | null = null;
	let icon: string | null = null;
	const zip = await openZip(file).catch(() => null);
	if (!zip) throw new InstanceError('That file is not a readable zip.');
	const read = async (entry: Parameters<typeof entryStream>[1]) => {
		const chunks: Buffer[] = [];
		for await (const chunk of await entryStream(zip, entry)) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks);
	};
	try {
		// Every entry is read, so a damaged one, or one naming a path outside the
		// folder (yauzl refuses those), turns the file away here, before the import.
		await zipEntries(zip, async (entry) => {
			if (entry.fileName === MANIFEST && text === null) text = (await read(entry)).toString('utf8');
			else if (entry.fileName === ICON_ENTRY && entry.uncompressedSize <= ICON_MAX_BYTES) {
				icon = `data:image/png;base64,${(await read(entry)).toString('base64')}`;
			}
		});
	} catch (err) {
		throw new InstanceError(`That file cannot be imported: ${err instanceof Error ? err.message : String(err)}.`);
	} finally {
		zip.close();
	}
	if (text === null) throw new InstanceError(`That is not a MineShell server export: it has no ${MANIFEST}.`);
	let manifest: BundleManifest;
	try {
		manifest = JSON.parse(text);
	} catch {
		throw new InstanceError(`${MANIFEST} in that file is damaged.`);
	}
	if (typeof manifest?.format !== 'number' || !manifest.server || typeof manifest.server.minecraftVersion !== 'string') {
		throw new InstanceError(`${MANIFEST} in that file is not one MineShell wrote.`);
	}
	if (manifest.format > BUNDLE_FORMAT) {
		throw new InstanceError(`That export is from a newer MineShell (${manifest.mineshell ?? 'unknown version'}); update this one to import it.`);
	}
	return { manifest, icon };
}

async function sweepStaged(): Promise<void> {
	const cutoff = Date.now() - STAGE_KEEP_MS;
	for (const [id, s] of staged) {
		if (s.at >= cutoff) continue;
		staged.delete(id);
		if (s.owned) await fs.rm(s.file, { force: true });
	}
}

/**
 * Keeps an export file for the import that follows: an upload (MineShell's
 * own copy, deleted after the import or after two hours) or a file already
 * on this machine (left where it is).
 */
export async function stageImport(file: string, fileName: string, owned: boolean): Promise<ImportPreview> {
	await sweepStaged();
	let bundle: Awaited<ReturnType<typeof readBundle>>;
	try {
		bundle = await readBundle(file);
	} catch (err) {
		if (owned) await fs.rm(file, { force: true });
		throw err;
	}
	const id = crypto.randomUUID();
	staged.set(id, { file, fileName, owned, ...bundle, at: Date.now() });
	return previewOf(id, staged.get(id)!, (await fs.stat(file)).size);
}

function previewOf(id: string, s: Staged, sizeBytes: number): ImportPreview {
	const m = s.manifest;
	return {
		id,
		fileName: s.fileName,
		sizeBytes,
		name: m.server.name,
		minecraftVersion: m.server.minecraftVersion,
		modloader: m.server.modloader,
		modloaderVersion: m.server.modloaderVersion,
		pack: m.server.pack?.name ? `${m.server.pack.name}${m.server.pack.versionName ? ` ${m.server.pack.versionName}` : ''}` : null,
		mineshell: m.mineshell,
		exportedAt: m.exportedAt,
		mods: m.records?.mods?.length ?? 0,
		downloads: m.downloads?.length ?? 0,
		included: m.included,
		icon: s.icon
	};
}

export async function stagedImport(id: string): Promise<ImportPreview | null> {
	const s = staged.get(id);
	const stat = s && (await fs.stat(s.file).catch(() => null));
	return s && stat ? previewOf(id, s, stat.size) : null;
}

/** A path inside the server folder, or null for one that leaves it. */
function insideServer(rel: unknown): string | null {
	if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\')) return null;
	const normal = path.posix.normalize(rel);
	if (normal.startsWith('/') || normal === '..' || normal.startsWith('../') || normal.split('/').includes('..')) return null;
	return normal;
}

const str = (v: unknown, max = 2000): string | null => (typeof v === 'string' && v.length <= max ? v : null);

/** The export's files into the server folder; entries outside files/ or leaving the folder are skipped. */
async function unpackFiles(file: string, root: string, total: number, task: TaskHandle): Promise<number> {
	const zip = await openZip(file);
	let done = 0;
	try {
		await zipEntries(zip, async (entry) => {
			if (!entry.fileName.startsWith(FILES) || entry.fileName.endsWith('/')) return;
			const rel = insideServer(entry.fileName.slice(FILES.length));
			if (!rel || rel === 'eula.txt') return;
			const out = safeJoin(root, rel);
			await fs.mkdir(path.dirname(out), { recursive: true });
			await pipeline(await entryStream(zip, entry), createWriteStream(out));
			done++;
			if (done % 100 === 0) task.setProgress(Math.min(100, (done / Math.max(total, 1)) * 100), 'Unpacking files');
		});
	} finally {
		zip.close();
	}
	return done;
}

function restoreRecords(instanceId: string, r: Partial<BundleManifest['records']>, task: TaskHandle): void {
	const now = Date.now();
	for (const mod of Array.isArray(r.mods) ? r.mods : []) {
		const filePath = insideServer(mod?.filePath);
		const source = str(mod?.source, 40);
		const slug = str(mod?.slug, 400);
		const name = str(mod?.name, 400);
		if (!filePath?.startsWith('mods/') || !source || !slug || !name) continue;
		db.insert(mods)
			.values({ source, slug, name, author: str(mod.author), summary: str(mod.summary), projectUrl: str(mod.projectUrl), iconUrl: str(mod.iconUrl) })
			.onConflictDoNothing()
			.run();
		const modId = db.select({ id: mods.id }).from(mods).where(and(eq(mods.source, source), eq(mods.slug, slug))).get()?.id;
		if (modId === undefined) continue;
		db.insert(instanceMods)
			.values({
				instanceId,
				modId,
				version: str(mod.version, 400),
				versionId: str(mod.versionId, 400),
				filePath,
				hash: str(mod.hash, 200),
				hashAlgo: mod.hashAlgo === 'sha1' || mod.hashAlgo === 'sha512' ? mod.hashAlgo : null,
				enabled: mod.enabled !== false && !filePath.endsWith(DISABLED_SUFFIX),
				fromPack: mod.fromPack === true,
				locked: mod.locked === true,
				clientOnly: mod.clientOnly === true,
				flags: str(mod.flags),
				installedAt: now
			})
			.onConflictDoNothing()
			.run();
	}
	for (const c of Array.isArray(r.scheduledCommands) ? r.scheduledCommands : []) {
		const command = str(c?.command, 1000);
		const schedule =
			typeof c?.everyMinutes === 'number' && Number.isInteger(c.everyMinutes) && c.everyMinutes >= 1 && c.everyMinutes <= 7 * 24 * 60
				? { everyMinutes: c.everyMinutes }
				: typeof c?.dailyTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(c.dailyTime)
					? { dailyTime: c.dailyTime }
					: null;
		if (!command?.trim() || !schedule) continue;
		const added = addScheduledCommand(instanceId, command, schedule);
		if (c.enabled === false) setScheduledCommandEnabled(instanceId, added.id, false);
	}
	if (Array.isArray(r.macros)) setMacros(instanceId, r.macros);
	for (const f of Array.isArray(r.playerFields) ? r.playerFields : []) {
		try {
			addCustomField(instanceId, { label: String(f?.label ?? ''), kind: String(f?.kind ?? ''), path: f?.path });
		} catch {
			task.log(`Left out the player field "${String(f?.label ?? '')}": it is not one this MineShell reads.`);
		}
	}
	for (const d of Array.isArray(r.datapacks) ? r.datapacks : []) {
		const fileName = str(d?.fileName, 300);
		const [source, projectId, slug, name] = [str(d?.source, 40), str(d?.projectId, 200), str(d?.slug, 200), str(d?.name, 400)];
		if (!fileName || fileName.includes('/') || fileName.startsWith('.') || !source || !projectId || !slug || !name) continue;
		db.insert(instanceDatapacks)
			.values({
				instanceId,
				source,
				projectId,
				slug,
				name,
				projectUrl: str(d.projectUrl),
				iconUrl: str(d.iconUrl),
				version: str(d.version, 400),
				versionId: str(d.versionId, 400),
				fileName,
				hash: str(d.hash, 200),
				installedAt: now
			})
			.onConflictDoNothing()
			.run();
	}
	if (r.snapshotPolicy && typeof r.snapshotPolicy === 'object') saveServerSnapshotOverrides(instanceId, r.snapshotPolicy);
	if (r.snapshotSchedule && typeof r.snapshotSchedule === 'object') saveSnapshotSchedule(instanceId, validSchedule(r.snapshotSchedule));
	for (const tag of Array.isArray(r.tags) ? r.tags : []) {
		const name = str(tag, 60)?.trim();
		const found = name ? createOrFindServerTag(name) : null;
		if (found) assignServerTag(instanceId, found.id);
	}
}

export type ImportChoices = Pick<CreateInstanceInput, 'serverPort' | 'acceptEula' | 'startWhenReady' | 'creatorId'> & {
	name: string;
	downloadJava?: JavaVendor;
};

/**
 * A new server from a staged export: the same loader installed, the carried
 * files unpacked, the listed mods downloaded again, settings and records
 * restored. Journalled like any new server: cut short, it is marked failed.
 */
export async function importServer(stagedId: string, choices: ImportChoices): Promise<{ instance: ServerInstance; taskId: string }> {
	const s = staged.get(stagedId);
	if (!s || !(await fs.stat(s.file).catch(() => null))) throw new InstanceError('That export is no longer here; upload it again.');
	const m = s.manifest;
	const source = m.server;
	const target = { minecraftVersion: source.minecraftVersion, modloader: source.modloader as CreateInstanceInput['modloader'], modloaderVersion: source.modloaderVersion, explicitPath: null };
	const java = await planJava(target, choices.downloadJava);
	const settings = checkedSettings(source.settings);
	const pack = source.pack ?? null;
	const instance = await insertInstanceRow({
		name: choices.name.trim() || source.name,
		minecraftVersion: source.minecraftVersion,
		modloader: target.modloader,
		modloaderVersion: source.modloaderVersion,
		memoryMaxMb: settings.memoryMaxMb ?? undefined,
		memoryMinMb: settings.memoryMinMb ?? undefined,
		serverPort: choices.serverPort,
		packSource: str(pack?.source, 40),
		packName: str(pack?.name, 400),
		packProjectId: str(pack?.projectId, 200),
		packVersionId: str(pack?.versionId, 200),
		packVersionName: str(pack?.versionName, 400),
		acceptEula: choices.acceptEula,
		startWhenReady: choices.startWhenReady,
		creatorId: choices.creatorId
	});
	staged.delete(stagedId);

	const taskId = startTask({ label: `Import ${instance.name}`, instanceId: instance.id }, (task) =>
		endJournalOnFailure(instance.id, async () => {
			try {
				task.log(`From ${s.fileName}, exported by MineShell ${m.mineshell} on ${new Date(m.exportedAt).toISOString().slice(0, 10)}.`);
				task.setProgress(null, 'Resolving Java');
				const javaPath = await obtainJava(java, javaTarget(instance), task);

				task.setProgress(null, `Installing ${instance.modloader}`);
				const installed = await getLoader(instance.modloader).install({
					dir: instance.path,
					minecraftVersion: instance.minecraftVersion,
					loaderVersion: instance.modloaderVersion,
					javaPath,
					task
				});

				task.setProgress(0, 'Unpacking files');
				const unpacked = await unpackFiles(s.file, instance.path, m.files ?? 0, task);
				task.log(`Unpacked ${unpacked} files.`);

				const downloads = (Array.isArray(m.downloads) ? m.downloads : [])
					.map((d) => ({ ...d, target: insideServer(d?.target) ?? '' }))
					.filter((d) => d.target.startsWith('mods/'));
				task.setProgress(0, 'Downloading mods');
				const { failures } = await downloadPackFiles(
					{
						kind: 'mrpack',
						name: source.name,
						version: null,
						minecraftVersion: instance.minecraftVersion,
						modloader: instance.modloader as CreateInstanceInput['modloader'],
						modloaderVersion: instance.modloaderVersion,
						downloads: downloads.map(({ size: _size, ...d }) => ({ ...d, urls: Array.isArray(d.urls) ? d.urls.filter((u) => typeof u === 'string') : [], required: true })),
						overrideEntries: [],
						zip: null
					},
					instance.path,
					task
				);
				await recordMissing(instance.path, failures);

				// The export's server.properties came with the files: this machine's ports and RCON password go in.
				const password = rconPassword(instance);
				await patchProperties(instance.path, {
					'server-port': String(instance.serverPort),
					'enable-rcon': 'true',
					'rcon.port': String(instance.rconPort),
					...(password ? { 'rcon.password': password } : {})
				});

				db.update(serverInstances)
					.set({
						...settings,
						launchArgs: installed.launchArgs,
						modloaderVersion: installed.loaderVersion,
						packDatapacks: str(pack?.datapacks, 100_000),
						updatedAt: Date.now()
					})
					.where(eq(serverInstances.id, instance.id))
					.run();
				restoreRecords(instance.id, m.records ?? {}, task);

				const voicePort = await claimVoicePort(requireInstance(instance.id), listInstances()).catch(() => null);
				if (voicePort) task.log(`Voice chat on UDP port ${voicePort}: another server here has the exported one.`);
				await syncUnit(requireInstance(instance.id));
				commitOperation(instance.id, { status: 'ready', statusMessage: failures.length ? missingNotice(failures.length) : null });
				audit('instance.imported', { instanceId: instance.id, detail: source.name });
				if (choices.startWhenReady) {
					if (failures.length) task.log('Not starting the server: some mods could not be downloaded.');
					else await startWhenInstalled(instance.id, task);
				} else if (choices.acceptEula && !(await eulaIsAccepted(requireInstance(instance.id)))) await acceptEula(requireInstance(instance.id));
				task.setProgress(100, 'Ready');
			} finally {
				if (s.owned) await fs.rm(s.file, { force: true });
			}
		})
	);
	watchTaskFailure(taskId, instance.id);
	return { instance, taskId };
}
