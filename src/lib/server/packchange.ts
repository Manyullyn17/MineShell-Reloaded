import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerInstance } from './db/schema';
import {
	bestVersion,
	DISABLED_SUFFIX,
	getModProvider,
	installModVersion,
	listInstanceMods,
	modsDir,
	setModEnabled,
	syncMods,
	type ModRow,
	type ProjectVersion
} from './mods';
import { describeClientOnlyResult, disableClientOnlyMods } from './clientonly';
import { snapshotStep } from './snapshots';
import { BASE_FILE, baseFromFiles, baseTag, mergeConfigs, packFiles, PROTECTED, readBase, REPORTS_DIR, writeBase, type Base } from './configmerge';
import { applyOverrides, curseforgeOrigins, downloadPackFiles, loadOverridesArchive, parsePack, resolvePackTargets, type ParsedPack } from './packs';
import { hashFile } from './download';
import { resolveProviderPack } from './packs/resolve';
import { getLoader, type ModloaderId } from './modloaders';
import { resolveJava } from './java';
import { startTask, type TaskHandle } from './tasks';
import { applyCleanroomModFixes, isCleanroomRequiredJar } from './cleanroom';
import { canUseCleanroom } from '#lib/shared/cleanroom.js';
import { datapackNames, isDatapackFile, packWorldFiles, packWorldName, serverWorldName } from './packworld';
import {
	beginOperation,
	commitOperation,
	endOperation,
	OperationInProgressError,
	updateOperation,
	type Journal
} from './operations';

export type PackChangeJournal = Extract<Journal, { kind: 'pack-change' }>;
import {
	audit,
	InstanceError,
	isLoaderInstallEntry,
	listEntries,
	obtainJava,
	planJava,
	restoreAside,
	requireInstance,
	requireStopped,
	setStatus,
	syncUnit,
	type JavaPlan
} from './instances';
import type { JavaVendor } from './javadownload';

/**
 * Moving an installed pack to another version of itself - up, down, or the
 * same version again to restore the pack's own files.
 *
 * What changes and what never does:
 * - Pack mods (tracked fromPack) are diffed by filename: gone ones are
 *   removed, new ones downloaded, unchanged ones left alone (keeping their
 *   enabled/disabled state). Mods the user added are never removed.
 * - Every top-level folder or file the new pack ships (config/, scripts/,
 *   resources/ ...) is moved to old-configs/<date>-<old version>/ first and
 *   then written fresh, so configs are never silently merged or lost.
 * - server.properties, the world, player lists and logs are never moved or
 *   overwritten, even when the pack ships its own copy. Inside the world,
 *   only the pack's data packs are synced (packworld.ts); the world folder
 *   is whatever level-name says, not just "world".
 * - Everything is reversible until the database is updated: a failure puts
 *   configs, mods and the loader back exactly as they were.
 */


// ---------------------------------------------------------------- preparing ---

/**
 * Resolving a CurseForge version means downloading its overrides.zip (MeatballCraft:
 * 154MB), so the preview keeps the result for the apply that usually follows.
 */
const prepared = new Map<string, { key: string; pack: ParsedPack; at: number }>();
const PREPARED_TTL = 30 * 60_000;

function packRef(instance: ServerInstance): { source: string; projectId: string } {
	if (!instance.packSource || !instance.packProjectId) {
		throw new InstanceError(
			'This server was not installed from a pack MineShell can look up (uploaded archives have no project to fetch other versions from).'
		);
	}
	return { source: instance.packSource, projectId: instance.packProjectId };
}

/** An uploaded pack file stands in for a provider version as `upload:<token>`. */
const UPLOAD_PREFIX = 'upload:';
export const isUploadedVersion = (versionId: string) => versionId.startsWith(UPLOAD_PREFIX);

/**
 * A new version of the pack as a file (.mrpack or CurseForge zip) - the only
 * way to update a server installed from an uploaded file, which has no
 * project to fetch versions from, and a way to install a build a provider
 * does not list. Kept like a looked-up version, for the preview and the apply.
 */
export async function prepareUploadedPack(instance: ServerInstance, buffer: Buffer): Promise<string> {
	const pack = parsePack(buffer);
	await resolvePackTargets(pack);
	const versionId = `${UPLOAD_PREFIX}${crypto.randomUUID()}`;
	prepared.set(instance.id, { key: versionId, pack, at: Date.now() });
	return versionId;
}

async function preparePack(instance: ServerInstance, versionId: string, task?: TaskHandle): Promise<ParsedPack> {
	if (isUploadedVersion(versionId)) {
		const hit = prepared.get(instance.id);
		if (hit?.key === versionId && Date.now() - hit.at < PREPARED_TTL) return hit.pack;
		throw new InstanceError('That uploaded pack file is no longer kept; upload it again.');
	}
	const { source, projectId } = packRef(instance);
	const key = `${source}:${projectId}:${versionId}`;
	const hit = prepared.get(instance.id);
	if (hit && hit.key === key && Date.now() - hit.at < PREPARED_TTL) return hit.pack;
	const { pack } = await resolveProviderPack(source, projectId, versionId);
	await loadOverridesArchive(pack, task);
	prepared.set(instance.id, { key, pack, at: Date.now() });
	return pack;
}

// ----------------------------------------------------------------- planning ---

function baseName(fileName: string): string {
	return fileName.endsWith(DISABLED_SUFFIX) ? fileName.slice(0, -DISABLED_SUFFIX.length) : fileName;
}

function overrideRelative(entry: string): string {
	return entry.replace(/^(server-overrides|overrides)\//, '');
}

/** Jar names the target version installs into mods/, from downloads and bundled overrides. */
export function targetModNames(pack: ParsedPack): Set<string> {
	const names = new Set<string>();
	for (const d of pack.downloads) {
		const dir = path.posix.dirname(d.target);
		if (dir === 'mods') names.add(path.posix.basename(d.target));
	}
	for (const e of pack.overrideEntries) {
		const rel = overrideRelative(e);
		if (path.posix.dirname(rel) === 'mods') names.add(path.posix.basename(rel));
	}
	return names;
}

/**
 * Top-level entries the target version writes, other than mods, protected
 * files and the world. `worldTops` are the top-level folders of the world
 * (the pack's and the server's level-name, and "world"); treating one as a
 * config folder used to move the whole world to old-configs.
 */
export function packTopLevel(pack: ParsedPack, worldTops: Set<string> = new Set(['world'])): string[] {
	const tops = new Set<string>();
	for (const e of pack.overrideEntries) tops.add(overrideRelative(e).split('/')[0]);
	for (const d of pack.downloads) if (d.target.includes('/')) tops.add(d.target.split('/')[0]);
	return [...tops].filter((t) => t && !PROTECTED.has(t) && !worldTops.has(t) && !isLoaderInstallEntry(t)).sort();
}

/** The world folders' top-level names: never config folders, never replaced. */
function worldTopsFor(...worlds: string[]): Set<string> {
	return new Set(['world', ...worlds].map((w) => w.split('/')[0]));
}

/**
 * Data packs the installed version shipped. Recorded since installs started
 * keeping track; for an older install, read from the installed version
 * itself (once per version, it can mean downloading its overrides). Null
 * when that is not possible either.
 */
const previousDatapacksCache = new Map<string, string[] | null>();
async function previousDatapacks(instance: ServerInstance): Promise<string[] | null> {
	if (instance.packDatapacks) {
		try {
			return JSON.parse(instance.packDatapacks) as string[];
		} catch {
			/* fall through */
		}
	}
	if (!instance.packSource || !instance.packProjectId || !instance.packVersionId) return null;
	const key = `${instance.packSource}:${instance.packProjectId}:${instance.packVersionId}`;
	if (!previousDatapacksCache.has(key)) {
		const names = await resolveProviderPack(instance.packSource, instance.packProjectId, instance.packVersionId)
			.then(async ({ pack }) => {
				await loadOverridesArchive(pack);
				return datapackNames(packWorldFiles(pack));
			})
			.catch(() => null);
		previousDatapacksCache.set(key, names);
	}
	return previousDatapacksCache.get(key) ?? null;
}

export function targetLoaderFor(
	instance: ServerInstance,
	pack: ParsedPack
): { loader: ModloaderId; version: string | null } {
	// A Forge 1.12.2 pack installed onto Cleanroom stays on Cleanroom.
	if (instance.modloader === 'cleanroom' && canUseCleanroom(pack.modloader, pack.minecraftVersion)) {
		return { loader: 'cleanroom', version: instance.modloaderVersion };
	}
	return {
		loader: pack.modloader,
		version:
			pack.modloaderVersion ??
			(pack.modloader === instance.modloader && pack.minecraftVersion === instance.minecraftVersion
				? instance.modloaderVersion
				: null)
	};
}

export type ManualModCheck = {
	fileName: string;
	name: string;
	source: string;
	currentVersion: string | null;
	status: 'update' | 'current' | 'unavailable' | 'unknown';
	targetVersion: string | null;
	/** Shown as an error when the mod probably will not work after the change. */
	blocking: boolean;
	message: string | null;
};

export type PackChangePlan = {
	versionId: string;
	sameVersion: boolean;
	/** The target is an uploaded file, not a version looked up from the provider. */
	uploaded: boolean;
	/** An uploaded file whose pack name differs from the installed pack's. */
	otherPack: boolean;
	current: { minecraft: string; loader: string; loaderVersion: string | null };
	target: { name: string; version: string | null; minecraft: string; loader: string; loaderVersion: string | null };
	minecraftChange: boolean;
	loaderChange: boolean;
	/** `update`: pack mods kept under the same file name whose content changed. */
	mods: { add: string[]; update: string[]; remove: string[]; keep: number };
	configs: string[];
	/** The world: only the pack's data packs change; other files the pack ships there are added where missing. */
	world: {
		/** The server's world folder (level-name). */
		folder: string;
		/** The folder the pack's own world files are under (its level-name). */
		packFolder: string;
		datapacks: { add: string[]; update: string[]; remove: string[] };
		/** Not known which data packs the installed version shipped, so none are removed. */
		previousUnknown: boolean;
		/** Other world files (paths inside the world) that do not exist yet and will be written. */
		newFiles: string[];
	};
	manual: ManualModCheck[];
	/** Reached into while applying; not sent to the client. On-disk names of `mods.update`. */
	packUpdates?: string[];
	/** Reached into while applying; not sent to the client. */
	updates?: Map<string, { source: string; project: { id: string; slug: string; name: string; projectUrl: string | null; iconUrl: string | null }; version: ProjectVersion }>;
};

async function checkManualMod(
	row: ModRow,
	target: { minecraft: string; loader: ModloaderId },
	breaking: boolean
): Promise<{ check: ManualModCheck; update?: NonNullable<PackChangePlan['updates']> extends Map<string, infer V> ? V : never }> {
	const base = {
		fileName: row.fileName,
		name: row.name,
		source: row.source,
		currentVersion: row.version,
		targetVersion: null
	};
	if ((row.source !== 'modrinth' && row.source !== 'curseforge') || !row.slug) {
		return {
			check: {
				...base,
				status: 'unknown',
				blocking: breaking,
				message: breaking
					? `Not from a known source, so MineShell cannot find a build for ${target.loader} ${target.minecraft}. Replace it by hand or it will likely fail to load.`
					: 'Not from a known source, so updates cannot be checked.'
			}
		};
	}
	const catalogLoader = getLoader(target.loader).catalogLoader ?? target.loader;
	try {
		const provider = getModProvider(row.source);
		const [project, versions] = await Promise.all([
			provider.getProject(row.slug),
			provider.listVersions(row.slug, { minecraftVersion: target.minecraft, loader: catalogLoader })
		]);
		const best = bestVersion(versions);
		if (!best) {
			return {
				check: {
					...base,
					status: 'unavailable',
					blocking: true,
					message: `No version for ${catalogLoader} ${target.minecraft}. It will stay as it is and will probably fail to load; disable or replace it.`
				}
			};
		}
		if (best.versionNumber === row.version) {
			return { check: { ...base, status: 'current', targetVersion: best.versionNumber, blocking: false, message: null } };
		}
		return {
			check: { ...base, status: 'update', targetVersion: best.versionNumber, blocking: false, message: null },
			update: {
				source: row.source,
				project: {
					id: project.id,
					slug: project.slug,
					name: project.name,
					projectUrl: project.projectUrl,
					iconUrl: project.iconUrl
				},
				version: best
			}
		};
	} catch (err) {
		return {
			check: {
				...base,
				status: 'unknown',
				blocking: breaking,
				message: `Could not check for a compatible version: ${err instanceof Error ? err.message : 'lookup failed'}.`
			}
		};
	}
}

/**
 * Pack mods present under the same name in both versions but with different
 * content - typically jars bundled in the overrides, which keep a fixed name
 * across pack releases. Compared by the file list's hash, or byte for byte
 * against the bundled copy. Returns on-disk file names (may be .disabled).
 */
export async function changedPackMods(root: string, pack: ParsedPack, packFiles: string[]): Promise<string[]> {
	const changed: string[] = [];
	for (const onDisk of packFiles) {
		const name = baseName(onDisk);
		const file = path.join(root, 'mods', onDisk);
		const download = pack.downloads.find((d) => d.target === `mods/${name}`);
		if (download?.hash) {
			const actual = await hashFile(file, download.hash.algo === 'sha1' ? 'sha1' : 'sha512').catch(() => null);
			if (actual && actual !== download.hash.value) changed.push(onDisk);
			continue;
		}
		const entry = pack.overrideEntries.filter((e) => overrideRelative(e) === `mods/${name}`).pop();
		const bundled = entry ? pack.zip?.readFile(entry) : null;
		if (bundled) {
			const current = await fs.readFile(file).catch(() => null);
			if (current && !current.equals(bundled)) changed.push(onDisk);
		}
	}
	return changed;
}

async function buildPlan(instance: ServerInstance, versionId: string, pack: ParsedPack): Promise<PackChangePlan> {
	const uploaded = isUploadedVersion(versionId);
	const target = targetLoaderFor(instance, pack);
	const minecraftChange = pack.minecraftVersion !== instance.minecraftVersion;
	const loaderChange =
		minecraftChange ||
		target.loader !== instance.modloader ||
		(target.version !== null && target.version !== instance.modloaderVersion);

	const rows = (await listInstanceMods(instance)).filter((r) => !r.missing);
	const wanted = targetModNames(pack);
	const present = new Set(rows.map((r) => baseName(r.fileName)));
	const packRows = rows.filter((r) => r.fromPack);
	const remove = packRows.filter((r) => !wanted.has(baseName(r.fileName))).map((r) => r.fileName);
	const add = [...wanted].filter((n) => !present.has(n)).sort();
	const packUpdates = await changedPackMods(
		instance.path,
		pack,
		packRows.filter((r) => wanted.has(baseName(r.fileName))).map((r) => r.fileName)
	);

	// A Minecraft or loader-family change is when a user mod is likely to break.
	const breaking = minecraftChange || target.loader !== instance.modloader;
	const manualRows = rows.filter(
		(r) => !r.fromPack && !(target.loader === 'cleanroom' && isCleanroomRequiredJar(baseName(r.fileName)))
	);
	const checks = await Promise.all(
		manualRows.map((r) => checkManualMod(r, { minecraft: pack.minecraftVersion, loader: target.loader }, breaking))
	);

	const updates: NonNullable<PackChangePlan['updates']> = new Map();
	for (const c of checks) if (c.update) updates.set(c.check.fileName, c.update);

	// The world: data packs by name, other files only where missing.
	const worldFolder = await serverWorldName(instance.path);
	const packFolder = packWorldName(pack);
	const worldFiles = packWorldFiles(pack, packFolder);
	const targetDatapacks = datapackNames(worldFiles);
	const presentDatapacks = await fs.readdir(path.join(instance.path, worldFolder, 'datapacks')).catch(() => [] as string[]);
	const previous = presentDatapacks.length ? await previousDatapacks(instance) : [];
	const newFiles: string[] = [];
	for (const f of worldFiles) {
		if (!isDatapackFile(f.rel) && !(await exists(path.join(instance.path, worldFolder, f.rel)))) newFiles.push(f.rel);
	}

	return {
		versionId,
		sameVersion: uploaded
			? pack.name === instance.packName && pack.version !== null && pack.version === instance.packVersionName
			: versionId === instance.packVersionId,
		uploaded,
		// A file names its pack; one with another name may be another pack altogether.
		otherPack: uploaded && !!instance.packName && pack.name.trim().toLowerCase() !== instance.packName.trim().toLowerCase(),
		current: {
			minecraft: instance.minecraftVersion,
			loader: instance.modloader,
			loaderVersion: instance.modloaderVersion
		},
		target: {
			name: pack.name,
			version: pack.version,
			minecraft: pack.minecraftVersion,
			loader: target.loader,
			loaderVersion: target.version
		},
		minecraftChange,
		loaderChange,
		mods: {
			add,
			update: packUpdates.map(baseName).sort(),
			remove,
			keep: packRows.length - remove.length - packUpdates.length
		},
		configs: packTopLevel(pack, worldTopsFor(worldFolder, packFolder)),
		world: {
			folder: worldFolder,
			packFolder,
			datapacks: {
				add: targetDatapacks.filter((n) => !presentDatapacks.includes(n)),
				update: targetDatapacks.filter((n) => presentDatapacks.includes(n)),
				remove: (previous ?? []).filter((n) => presentDatapacks.includes(n) && !targetDatapacks.includes(n)).sort()
			},
			previousUnknown: previous === null,
			newFiles: newFiles.sort()
		},
		manual: checks.map((c) => c.check),
		updates,
		packUpdates
	};
}

/** Preview: resolve the target version and work out every change, touching nothing. */
export async function planPackChange(instance: ServerInstance, versionId: string): Promise<PackChangePlan> {
	const pack = await preparePack(instance, versionId);
	const plan = await buildPlan(instance, versionId, pack);
	delete plan.updates;
	delete plan.packUpdates;
	return plan;
}

// ----------------------------------------------------------------- applying ---

/**
 * The installed version's own files, which the user's copies are compared
 * against: saved at install or the last change, else (servers from before
 * that) read once from the installed version itself - its overrides download
 * again. Null when neither is possible (an uploaded pack without a saved base).
 */
async function mergeBase(instance: ServerInstance, task: TaskHandle): Promise<Base | null> {
	const saved = await readBase(instance.path);
	if (saved?.tag === baseTag(instance)) return saved;
	if (!instance.packSource || !instance.packProjectId || !instance.packVersionId) return null;
	try {
		task.setProgress(null, 'Reading the installed version’s original configs');
		const { pack } = await resolveProviderPack(instance.packSource, instance.packProjectId, instance.packVersionId);
		await loadOverridesArchive(pack, task);
		const world = await serverWorldName(instance.path);
		return baseFromFiles(packFiles(pack, worldTopsFor(world, packWorldName(pack))));
	} catch (err) {
		task.log(`Could not read the installed version’s original configs: ${err instanceof Error ? err.message : 'unknown error'}.`);
		return null;
	}
}

function stampFor(label: string | null): string {
	const date = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
	const version = (label ?? 'unknown')
		.replace(/\.(zip|mrpack)$/i, '')
		.replace(/[^A-Za-z0-9._-]+/g, '_')
		.slice(0, 60);
	return `${date}-${version}`;
}

async function exists(p: string): Promise<boolean> {
	return fs.access(p).then(
		() => true,
		() => false
	);
}

export async function applyPackChange(
	instance: ServerInstance,
	versionId: string,
	opts: { updateMods: string[]; confirmMinecraftChange: boolean; snapshot?: boolean; downloadJava?: JavaVendor }
): Promise<string> {
	await requireStopped(instance);
	const pack = await preparePack(instance, versionId);
	const plan = await buildPlan(instance, versionId, pack);

	if (plan.minecraftChange && !opts.confirmMinecraftChange) {
		throw new InstanceError(
			`This changes Minecraft from ${plan.current.minecraft} to ${plan.target.minecraft}. Confirm the warning to continue.`
		);
	}
	const loader = getLoader(plan.target.loader);
	const javaFor = {
		minecraftVersion: plan.target.minecraft,
		modloader: plan.target.loader,
		modloaderVersion: plan.target.loaderVersion,
		explicitPath: instance.javaPath
	};
	let javaPlan: JavaPlan | null = null;
	if (plan.loaderChange) {
		javaPlan = await planJava(javaFor, opts.downloadJava);
		// A pin to the wrong Java is the person's to change, not something to download around.
		const pinnedWarning = instance.javaPath ? resolveJava(javaFor).warning : null;
		if (pinnedWarning) throw new InstanceError(pinnedWarning);
	}

	const label = `${plan.target.name} ${plan.target.version ?? versionId}`;
	const root = instance.path;
	const mods = modsDir(root);
	const configsBefore = new Set<string>();
	for (const name of plan.configs) if (await exists(path.join(root, name))) configsBefore.add(name);
	const journal: PackChangeJournal = {
		kind: 'pack-change',
		staging: path.join('.mineshell', `pack-change-${Date.now()}`),
		oldConfigs: path.join('old-configs', stampFor(instance.packVersionName ?? instance.packVersionId)),
		modsBefore: await fs.readdir(mods).catch(() => [] as string[]),
		configs: plan.configs,
		configsBefore: [...configsBefore],
		loaderBefore: null,
		world: {
			datapacks: path.join(plan.world.folder, 'datapacks'),
			datapacksBefore: await fs.readdir(path.join(root, plan.world.folder, 'datapacks')).catch(() => [] as string[]),
			added: plan.world.newFiles.map((rel) => path.join(plan.world.folder, rel))
		}
	};
	try {
		beginOperation(instance.id, journal);
	} catch (err) {
		if (err instanceof OperationInProgressError) throw new InstanceError(err.message);
		throw err;
	}
	setStatus(instance.id, 'provisioning', `Changing pack to ${label}`);
	const taskId = startTask({ label: `Change ${instance.name} to ${label}`, instanceId: instance.id }, async (task) => {
		const staging = path.join(root, journal.staging);
		const oldConfigs = path.join(root, journal.oldConfigs);
		const modsBefore = new Set(journal.modsBefore);
		const movedConfigs: string[] = [];
		let downloadFailures: { file: string; error: string }[] = [];
		const problems: string[] = [];

		try {
			const javaPath = javaPlan ? await obtainJava(javaPlan, javaFor, task) : null;
			if (opts.snapshot) {
				const what = plan.sameVersion ? `reinstalling ${label}` : `changing the pack to ${label}`;
				await snapshotStep(instance, { reason: 'pack-change', label: `Before ${what}` }, task);
			}
			await fs.mkdir(path.join(staging, 'mods'), { recursive: true });
			// The installed version's originals, to tell the user's config edits from the pack's.
			const base = configsBefore.size ? await mergeBase(instance, task) : null;

			// 1. Configs and other pack-shipped folders go to old-configs, whole.
			task.setProgress(null, 'Moving current configs to old-configs');
			for (const name of configsBefore) {
				await fs.mkdir(oldConfigs, { recursive: true });
				await fs.rename(path.join(root, name), path.join(oldConfigs, name));
				movedConfigs.push(name);
			}
			if (movedConfigs.length) {
				task.log(`Moved ${movedConfigs.join(', ')} to ${path.relative(root, oldConfigs)}/.`);
			}

			// 1b. The world's data packs: the ones the new version dropped go to
			// old-configs, the ones it ships again are staged (restorable) before
			// being written fresh. The user's own are not touched.
			const datapacks = path.join(root, journal.world!.datapacks);
			for (const name of plan.world.datapacks.remove) {
				await fs.mkdir(path.join(oldConfigs, journal.world!.datapacks), { recursive: true });
				await fs.rename(path.join(datapacks, name), path.join(oldConfigs, journal.world!.datapacks, name));
				task.log(`Moved data pack ${name} to ${path.relative(root, oldConfigs)}/.`);
			}
			for (const name of plan.world.datapacks.update) {
				await fs.mkdir(path.join(staging, 'datapacks'), { recursive: true });
				await fs.rename(path.join(datapacks, name), path.join(staging, 'datapacks', name));
			}

			// 2. Pack mods the new version no longer has.
			for (const fileName of plan.mods.remove) {
				await fs.rename(path.join(mods, fileName), path.join(staging, 'mods', fileName));
				task.log(`Removed ${fileName}`);
			}

			// 3. Pack mods kept under the same name but changed in content are
			// staged (restorable) and fetched again; a disabled one stays disabled.
			const reDisable: string[] = [];
			for (const onDisk of plan.packUpdates ?? []) {
				await fs.rename(path.join(mods, onDisk), path.join(staging, 'mods', onDisk));
				if (onDisk.endsWith(DISABLED_SUFFIX)) reDisable.push(baseName(onDisk));
				task.log(`Updating pack mod ${baseName(onDisk)}`);
			}

			// 4. New pack files: mods not already present, plus everything outside mods/.
			const present = new Set([...modsBefore].filter((n) => !(plan.packUpdates ?? []).includes(n)).map(baseName));
			const worldTops = worldTopsFor(plan.world.folder, plan.world.packFolder);
			const packWorldPrefix = `${plan.world.packFolder}/`;
			const newWorldFiles = new Set(plan.world.newFiles);
			// A world file is written to the server's world folder: data packs
			// always, anything else only where nothing existed.
			const worldTarget = (rel: string): string | null => {
				const inWorld = rel.slice(packWorldPrefix.length);
				return isDatapackFile(inWorld) || newWorldFiles.has(inWorld) ? path.posix.join(plan.world.folder, inWorld) : null;
			};
			const toDownload: typeof pack.downloads = [];
			for (const d of pack.downloads) {
				if (d.target.startsWith(packWorldPrefix)) {
					const target = worldTarget(d.target);
					if (target) toDownload.push({ ...d, target });
					continue;
				}
				const dir = d.target ? path.posix.dirname(d.target) : 'mods';
				const top = d.target.split('/')[0];
				if ((PROTECTED.has(top) || worldTops.has(top)) && dir !== 'mods') continue;
				if (dir !== 'mods' || !present.has(path.posix.basename(d.target))) toDownload.push(d);
			}
			task.setProgress(0, 'Downloading pack files');
			({ failures: downloadFailures } = await downloadPackFiles({ ...pack, downloads: toDownload }, root, task));

			// 5. Overrides, minus protected files and jars that are already there.
			const overrideEntries = pack.overrideEntries.filter((e) => {
				const rel = overrideRelative(e);
				const top = rel.split('/')[0];
				if (rel.startsWith(packWorldPrefix)) return true;
				if (top === 'mods') return path.posix.dirname(rel) === 'mods' && !present.has(path.posix.basename(rel));
				return !PROTECTED.has(top) && !worldTops.has(top) && !isLoaderInstallEntry(top);
			});
			task.setProgress(null, 'Unpacking pack overrides');
			const copied = await applyOverrides({ ...pack, overrideEntries }, root, (rel) =>
				rel.startsWith(packWorldPrefix) ? worldTarget(rel) : rel
			);
			if (copied) task.log(`Copied ${copied} files from the pack's overrides.`);
			for (const name of reDisable) {
				await fs.rename(path.join(mods, name), path.join(mods, `${name}${DISABLED_SUFFIX}`)).catch(() => undefined);
			}

			// 5b. The user's config edits come back into the new pack's files
			// (configmerge.ts); old-configs keeps their copies either way.
			if (base && movedConfigs.length) {
				task.setProgress(null, 'Bringing back your config edits');
				const report = await mergeConfigs(root, oldConfigs, movedConfigs, base, path.join(staging, 'config-merge'), path.basename(journal.oldConfigs));
				const count = (o: string) => report.entries.filter((e) => e.outcome === o).length;
				const parts = [
					[count('kept') + count('carried'), 'kept as you had them'],
					[count('merged'), 'merged with the pack’s changes'],
					[count('conflict') + count('both-added'), 'changed by both: the pack’s lines are in place, review them in Settings']
				].filter(([n]) => n);
				if (parts.length) task.log(`Your config edits: ${parts.map(([n, what]) => `${n} ${what}`).join(', ')}.`);
				if (count('conflict') + count('both-added')) {
					problems.push(`${count('conflict') + count('both-added')} config file(s) were changed by both you and the pack; review them under Settings > Modpack.`);
				}
			} else if (movedConfigs.length) {
				task.log('No record of the installed pack version’s own configs, so your edits stay in old-configs/ only.');
			}
			// This version's originals, the base for the next change, tagged with
			// the version the commit records (a rollback leaves a base whose tag no
			// longer matches, which is then not used), and the merge's report.
			const committed = plan.uploaded
				? { packVersionId: null, packName: pack.name, packVersionName: pack.version }
				: { packVersionId: versionId, packName: instance.packName, packVersionName: pack.version };
			// The old one is staged, so a rollback puts it back (an uploaded pack cannot fetch it again).
			await fs.rename(path.join(root, BASE_FILE), path.join(staging, 'pack-base.zip')).catch(() => undefined);
			await writeBase(packFiles(pack, worldTops), path.join(root, BASE_FILE), baseTag({ ...instance, ...committed }));
			if (await exists(path.join(staging, 'config-merge', 'report.json'))) {
				await fs.mkdir(path.join(root, REPORTS_DIR), { recursive: true });
				await fs.rename(path.join(staging, 'config-merge'), path.join(root, REPORTS_DIR, path.basename(journal.oldConfigs)));
			}

			// 6. User mods the user chose to update.
			for (const fileName of opts.updateMods) {
				const update = plan.updates?.get(fileName);
				if (!update) continue;
				task.log(`Updating ${update.project.name} to ${update.version.versionNumber}`);
				// The old jar is staged first so a rollback can restore it even
				// when the new file has the same name.
				await fs.rename(path.join(mods, fileName), path.join(staging, 'mods', fileName));
				const installed = await installModVersion(
					instance,
					update.source as 'modrinth' | 'curseforge',
					update.project,
					update.version
				);
				if (fileName.endsWith(DISABLED_SUFFIX)) await setModEnabled(instance, installed, false);
			}

			// 7. The loader, when the pack's loader or Minecraft version moved.
			let launchArgs = instance.launchArgs;
			let loaderVersion = instance.modloaderVersion;
			if (plan.loaderChange && javaPath) {
				task.setProgress(null, `Installing ${loader.label} ${plan.target.loaderVersion ?? '(latest)'}`);
				// Journalled before anything moves, so a restart mid-move knows
				// which loader files were the originals.
				journal.loaderBefore = await listEntries(root, isLoaderInstallEntry);
				updateOperation(instance.id, journal);
				await fs.mkdir(path.join(staging, 'loader'), { recursive: true });
				for (const name of journal.loaderBefore) {
					await fs.rename(path.join(root, name), path.join(staging, 'loader', name));
				}
				const result = await loader.install({
					dir: root,
					minecraftVersion: plan.target.minecraft,
					loaderVersion: plan.target.loaderVersion,
					javaPath,
					task
				});
				launchArgs = result.launchArgs;
				loaderVersion = result.loaderVersion;
			}

			commitOperation(instance.id, {
				minecraftVersion: plan.target.minecraft,
				modloader: plan.target.loader,
				modloaderVersion: loaderVersion,
				launchArgs,
				// An uploaded file is no provider version: the server is no longer on one it can name.
				...committed,
				packDatapacks: JSON.stringify([...plan.world.datapacks.add, ...plan.world.datapacks.update].sort())
			});
		} catch (err) {
			task.log('The change failed; putting everything back.');
			await restorePackChange(root, journal);
			endOperation(instance.id);
			await syncMods(requireInstance(instance.id)).catch(() => undefined);
			setStatus(
				instance.id,
				'ready',
				`Changing the pack version failed and the server was restored: ${err instanceof Error ? err.message : 'unknown error'}`
			);
			throw err;
		}

		// Committed. Tidy up and re-track; problems here are reported, not rolled back.
		await fs.rm(staging, { recursive: true, force: true });
		prepared.delete(instance.id);
		if (downloadFailures.length) {
			problems.push(`${downloadFailures.length} pack file(s) could not be downloaded; see the task log.`);
		}
		const blocking = plan.manual.filter((m) => m.blocking && !opts.updateMods.includes(m.fileName));
		if (blocking.length) {
			problems.push(`${blocking.length} of your own mod(s) have no compatible version: ${blocking.map((m) => m.name).join(', ')}.`);
		}
		try {
			task.setProgress(null, 'Identifying mods');
			await syncMods(requireInstance(instance.id), { fromPack: true, curseforge: curseforgeOrigins(pack) });
			// Only what this version added: a pack mod someone re-enabled stays on.
			task.setProgress(null, 'Checking for client-only mods');
			const clientOnly = await disableClientOnlyMods(requireInstance(instance.id), plan.mods.add, task);
			const line = describeClientOnlyResult(clientOnly);
			if (line) problems.push(line);
			if (plan.target.loader === 'cleanroom') {
				const fixes = await applyCleanroomModFixes(requireInstance(instance.id), task);
				problems.push(...fixes.failures);
			}
		} catch (err) {
			problems.push(`Re-tracking mods failed: ${err instanceof Error ? err.message : 'unknown error'}. Use Sync on the mods page.`);
		} finally {
			await syncUnit(requireInstance(instance.id));
		}
		setStatus(instance.id, 'ready', problems.length ? problems.join(' ') : null);
		audit('instance.pack_changed', {
			instanceId: instance.id,
			detail: `${instance.packVersionName ?? instance.packVersionId ?? '?'} -> ${plan.uploaded ? `${label} (uploaded file)` : versionId}`
		});
		task.setProgress(100, 'Ready');
	});
	return taskId;
}

/**
 * Puts an instance back as it was before a pack change, from its journal.
 * What was already moved is read from disk (every move is a rename into the
 * staging or old-configs folder), so the same code serves a failure while
 * MineShell runs and recovery after a restart.
 */
export async function restorePackChange(root: string, journal: PackChangeJournal): Promise<void> {
	const mods = modsDir(root);
	const staging = path.join(root, journal.staging);
	const oldConfigs = path.join(root, journal.oldConfigs);
	const listed = (dir: string) => fs.readdir(dir).catch(() => [] as string[]);

	// Loader: drop whatever the new install left, bring the old one back.
	// Originals that were never moved are left exactly where they are.
	if (journal.loaderBefore) {
		await restoreAside(root, path.join(staging, 'loader'), journal.loaderBefore, isLoaderInstallEntry);
	}
	// Mods: anything new goes, staged ones return.
	const modsBefore = new Set(journal.modsBefore);
	for (const name of await listed(mods)) {
		if (!modsBefore.has(name)) await fs.rm(path.join(mods, name), { force: true });
	}
	for (const name of await listed(path.join(staging, 'mods'))) {
		await fs.rename(path.join(staging, 'mods', name), path.join(mods, name));
	}
	// World: data packs the change added go, staged and moved-aside ones
	// return, and other world files it created go. Nothing else in the world
	// was touched.
	if (journal.world) {
		const datapacks = path.join(root, journal.world.datapacks);
		for (const name of await listed(datapacks)) {
			if (!journal.world.datapacksBefore.includes(name)) await fs.rm(path.join(datapacks, name), { recursive: true, force: true });
		}
		for (const name of await listed(path.join(staging, 'datapacks'))) {
			await fs.rm(path.join(datapacks, name), { recursive: true, force: true });
			await fs.rename(path.join(staging, 'datapacks', name), path.join(datapacks, name));
		}
		for (const name of await listed(path.join(oldConfigs, journal.world.datapacks))) {
			await fs.mkdir(datapacks, { recursive: true });
			await fs.rename(path.join(oldConfigs, journal.world.datapacks, name), path.join(datapacks, name));
		}
		for (const rel of journal.world.added) await fs.rm(path.join(root, rel), { force: true });
	}
	// Configs: the fresh copies go, the moved originals return. An original
	// that was never moved is still the real one and is left alone.
	const moved = new Set((await listed(oldConfigs)).filter((n) => journal.configs.includes(n)));
	for (const name of journal.configs) {
		if (journal.configsBefore.includes(name) && !moved.has(name)) continue;
		await fs.rm(path.join(root, name), { recursive: true, force: true });
	}
	for (const name of moved) {
		await fs.rename(path.join(oldConfigs, name), path.join(root, name));
	}
	await fs.rm(oldConfigs, { recursive: true, force: true });
	await fs.rmdir(path.dirname(oldConfigs)).catch(() => undefined);
	// The installed version's saved originals, if the change had moved them aside.
	if (await exists(path.join(staging, 'pack-base.zip'))) {
		await fs.rename(path.join(staging, 'pack-base.zip'), path.join(root, BASE_FILE));
	}
	// The config merge's report describes files just put back.
	await fs.rm(path.join(root, REPORTS_DIR, path.basename(journal.oldConfigs)), { recursive: true, force: true });
	await fs.rm(staging, { recursive: true, force: true });
}
