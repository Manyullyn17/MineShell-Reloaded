import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { auditLog, instanceMods, serverInstances, type ServerInstance } from './db/schema';
import { INSTANCES_DIR, instanceDir, unitName } from './config';
import { decryptSecret, encryptSecret, randomPassword } from './crypto';
import { BUILT_IN_PRESETS, composeJvmArgs, getPreset, stripJava8OnlyFlags } from './jvm-presets';
import { allocatePortPair, portIsFree } from './ports';
import {
	defaultProperties,
	fillPropertyDefaults,
	patchProperties,
	readProperties,
	writeProperties
} from './properties';
import { learnJavaRequirement, listJavaRuntimes, resolveJava, scanJavaRuntimes } from './java';
import {
	restartUnit,
	startUnit,
	stopUnit,
	unitState,
	writeRestartPolicy,
	writeUnitEnv,
	removeUnitArtifacts,
	resetFailed,
	type UnitState
} from './systemd';
import { rconExec, parsePlayerList } from './rcon';
import { getTask, startTask, type TaskHandle } from './tasks';
import { getLoader, type ModloaderId } from './modloaders';
import {
	applyOverrides,
	curseforgeOrigins,
	downloadPackFiles,
	loadOverridesArchive,
	parsePack,
	type ParsedPack
} from './packs';
import { deleteMod, listInstanceMods, setModEnabled, syncMods, DISABLED_SUFFIX } from './mods';
import { describeClientOnlyResult, disableClientOnlyMods } from './clientonly';
import { applyCleanroomModFixes } from './cleanroom';
import { defaultMaxMb, getInstanceDefaults } from './instance-defaults';
import { datapackNames, mapWorldPath, packLevelName, packWorldFiles, packWorldName } from './packworld';
import {
	beginOperation,
	commitOperation,
	endOperation,
	OperationInProgressError,
	type Journal
} from './operations';
import { canUseCleanroom, cleanroomJavaMajor } from '$lib/shared/cleanroom';
import { directorySize } from './files';
import { snapshotStep } from './snapshots';
import { installJava, type JavaVendor } from './javadownload';

export class InstanceError extends Error {}

/** systemd instance names are unit-escaped; keeping ids boring avoids surprises. */
export function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return slug || 'instance';
}

export function uniqueId(name: string): string {
	const base = slugify(name);
	let candidate = base;
	let n = 2;
	while (db.select().from(serverInstances).where(eq(serverInstances.id, candidate)).get()) {
		candidate = `${base}-${n++}`;
	}
	return candidate;
}

export function listInstances(): ServerInstance[] {
	return db.select().from(serverInstances).all();
}

export function getInstance(id: string): ServerInstance | undefined {
	return db.select().from(serverInstances).where(eq(serverInstances.id, id)).get();
}

export function requireInstance(id: string): ServerInstance {
	const instance = getInstance(id);
	if (!instance) throw new InstanceError(`No instance called "${id}".`);
	return instance;
}

export function audit(
	action: string,
	opts: { instanceId?: string | null; detail?: string; actor?: string } = {}
): void {
	db.insert(auditLog)
		.values({
			timestamp: Date.now(),
			instanceId: opts.instanceId ?? null,
			action,
			detail: opts.detail ?? null,
			actor: opts.actor ?? 'ui'
		})
		.run();
}

export function rconPassword(instance: ServerInstance): string | null {
	return decryptSecret(instance.rconPasswordEnc);
}

// ------------------------------------------------------------- unit syncing ---

/**
 * Everything systemd needs to know about an instance is derived from the DB row,
 * so this is called after any settings change. It is safe to run repeatedly.
 */
export async function syncUnit(instance: ServerInstance): Promise<{ warning: string | null }> {
	const java = resolveJava({
		explicitPath: instance.javaPath,
		minecraftVersion: instance.minecraftVersion,
		modloader: instance.modloader,
		modloaderVersion: instance.modloaderVersion
	});

	await writeUnitEnv(instance.id, {
		java: java.path ?? '/usr/bin/java',
		jvmArgs: instance.jvmArgs,
		launchArgs: instance.launchArgs
	});

	await writeRestartPolicy(
		instance.id,
		instance.autoRestartOnCrash,
		instance.crashRestartLimit,
		instance.crashRestartWindowSec
	);

	return { warning: java.warning };
}

// ----------------------------------------------------------------- creation ---

export type CreateInstanceInput = {
	name: string;
	minecraftVersion: string;
	modloader: ModloaderId;
	modloaderVersion?: string | null;
	memoryMinMb?: number;
	memoryMaxMb?: number;
	javaPath?: string | null;
	notes?: string | null;
	/** Download this vendor's runtime first when the needed Java is not installed. */
	downloadJava?: JavaVendor;
};

function jvmArgsFor(presetId: string, minMb: number, maxMb: number): string {
	// A preset, so a new instance starts from something that is still
	// reselectable later rather than a one-off string.
	const preset = getPreset(presetId) ?? getPreset('aikar') ?? BUILT_IN_PRESETS[0];
	return composeJvmArgs(preset.flags, minMb, maxMb);
}

/** server.properties for a new server: built-in values, the stored defaults over them, then what MineShell assigns. */
function newServerProperties(opts: Parameters<typeof defaultProperties>[0]): Record<string, string> {
	const assigned = defaultProperties(opts);
	return { ...assigned, ...getInstanceDefaults().properties };
}

async function insertInstanceRow(
	input: CreateInstanceInput & {
		packSource?: string | null;
		packName?: string | null;
		packProjectId?: string | null;
		packVersionId?: string | null;
		packVersionName?: string | null;
	}
): Promise<ServerInstance> {
	const id = uniqueId(input.name);
	const dir = instanceDir(id);
	await fs.mkdir(path.join(dir, 'mods'), { recursive: true });
	await fs.mkdir(path.join(dir, '.mineshell'), { recursive: true });

	const { serverPort, rconPort } = await allocatePortPair();
	const password = randomPassword();
	const defaults = getInstanceDefaults();
	const maxMb = input.memoryMaxMb ?? defaultMaxMb(defaults);
	const minMb = Math.min(input.memoryMinMb ?? defaults.memoryMinMb, maxMb);
	const now = Date.now();

	db.insert(serverInstances)
		.values({
			id,
			name: input.name.trim(),
			path: dir,
			minecraftVersion: input.minecraftVersion,
			modloader: input.modloader,
			modloaderVersion: input.modloaderVersion ?? null,
			packSource: input.packSource ?? null,
			packName: input.packName ?? null,
			packProjectId: input.packProjectId ?? null,
			packVersionId: input.packVersionId ?? null,
			packVersionName: input.packVersionName ?? null,
			launchArgs: '-jar server.jar nogui',
			jvmArgs: jvmArgsFor(defaults.jvmPreset, minMb, maxMb),
			memoryMinMb: minMb,
			memoryMaxMb: maxMb,
			...defaults.restarts,
			...defaults.console,
			javaPath: input.javaPath ?? null,
			serverPort,
			rconPort,
			rconPasswordEnc: encryptSecret(password),
			status: 'provisioning',
			statusMessage: 'Queued',
			notes: input.notes ?? null,
			createdAt: now,
			updatedAt: now
		})
		.run();
	// Committed (and so dropped) with the final 'ready'; still there after a
	// restart means the install never finished.
	beginOperation(id, { kind: 'create' });

	await writeProperties(
		dir,
		newServerProperties({
			port: serverPort,
			rconPort,
			rconPassword: password,
			motd: input.name.trim(),
			minecraftVersion: input.minecraftVersion
		})
	);

	return requireInstance(id);
}

export function setStatus(id: string, status: string, message: string | null) {
	db.update(serverInstances)
		.set({ status, statusMessage: message, updatedAt: Date.now() })
		.where(eq(serverInstances.id, id))
		.run();
}

/**
 * Starts the journal for an operation, reporting one already in progress
 * the way every other refusal is reported.
 */
function journal(instanceId: string, entry: Journal): void {
	try {
		beginOperation(instanceId, entry);
	} catch (err) {
		if (err instanceof OperationInProgressError) throw new InstanceError(err.message);
		throw err;
	}
}

/** A failed first install has nothing to restore; its journal just goes. */
function endJournalOnFailure<T>(instanceId: string, run: () => Promise<T>): Promise<T> {
	return run().catch((err) => {
		endOperation(instanceId);
		throw err;
	});
}

/** No runtime for the Java an operation needs; the form offers to download one. */
export class JavaMissingError extends InstanceError {
	constructor(
		readonly major: number,
		message: string
	) {
		super(message);
	}
}

type JavaTarget = {
	minecraftVersion: string;
	modloader: string;
	modloaderVersion: string | null;
	explicitPath: string | null;
};

/** The Java an operation will use: installed already, or to be downloaded by its task. */
export type JavaPlan = { path: string } | { download: JavaVendor; major: number };

/**
 * Settles Java before an operation starts anything, so a missing runtime is
 * a question on the form instead of a failed install. With `download` the
 * runtime is fetched as the task's first step (obtainJava).
 */
export async function planJava(target: JavaTarget, download?: JavaVendor): Promise<JavaPlan> {
	await learnJavaRequirement(target.minecraftVersion);
	let java = resolveJava(target);
	if (!java.path) {
		// First run on a fresh box often has an empty java table.
		await scanJavaRuntimes();
		java = resolveJava(target);
	}
	if (java.path) return { path: java.path };
	if (download) return { download, major: java.requiredMajor };
	throw new JavaMissingError(java.requiredMajor, java.warning ?? `No Java ${java.requiredMajor} runtime is available on this machine.`);
}

export async function obtainJava(plan: JavaPlan, target: JavaTarget, task: TaskHandle): Promise<string> {
	if ('path' in plan) return plan.path;
	await installJava(plan.download, plan.major, task);
	const java = resolveJava(target);
	if (!java.path) throw new InstanceError(`Java ${plan.major} was downloaded but does not match this server.`);
	return java.path;
}

function javaTarget(instance: Pick<ServerInstance, 'minecraftVersion' | 'modloader' | 'modloaderVersion' | 'javaPath'>): JavaTarget {
	return {
		minecraftVersion: instance.minecraftVersion,
		modloader: instance.modloader,
		modloaderVersion: instance.modloaderVersion,
		explicitPath: instance.javaPath
	};
}

/** Create an instance with only a mod loader installed. */
export async function createFromLoader(input: CreateInstanceInput): Promise<{ instance: ServerInstance; taskId: string }> {
	const java = await planJava(
		javaTarget({ ...input, modloaderVersion: input.modloaderVersion ?? null, javaPath: input.javaPath ?? null }),
		input.downloadJava
	);
	return insertInstanceRow(input).then((instance) => {
		const taskId = startTask(
			{ label: `Create ${instance.name}`, instanceId: instance.id },
			(task) => endJournalOnFailure(instance.id, async () => {
				task.setProgress(null, 'Resolving Java');
				const javaPath = await obtainJava(java, javaTarget(instance), task);

				task.setProgress(null, `Installing ${input.modloader}`);
				const loader = getLoader(input.modloader);
				const result = await loader.install({
					dir: instance.path,
					minecraftVersion: instance.minecraftVersion,
					loaderVersion: input.modloaderVersion ?? null,
					javaPath,
					task
				});

				db.update(serverInstances)
					.set({
						launchArgs: result.launchArgs,
						modloaderVersion: result.loaderVersion,
						updatedAt: Date.now()
					})
					.where(eq(serverInstances.id, instance.id))
					.run();

				if (input.modloader === 'cleanroom') {
					task.log(
						'Most Forge mods also need Fugue and Scalar Legacy on Cleanroom; "Apply required fixes" in the instance settings adds both.'
					);
				}

				await syncUnit(requireInstance(instance.id));
				commitOperation(instance.id, { status: 'ready', statusMessage: null });
				audit('instance.created', { instanceId: instance.id, detail: input.modloader });
				task.setProgress(100, 'Ready');
			})
		);
		// The task marks the instance failed on error so the UI can offer a retry.
		watchTaskFailure(taskId, instance.id);
		return { instance, taskId };
	});
}

/** Create an instance from an uploaded .mrpack or CurseForge zip. */
export async function createFromArchive(
	name: string,
	buffer: Buffer,
	overrides: Partial<CreateInstanceInput> = {}
): Promise<{ instance: ServerInstance; taskId: string; pack: ParsedPack }> {
	const pack = parsePack(buffer);
	const created = await createFromPack(
		name,
		pack,
		{ source: pack.kind === 'mrpack' ? 'modrinth' : 'curseforge' },
		overrides
	);
	return { ...created, pack };
}

/** Shared provisioning task for any pack shape, archive or file list. */
function provisionFromPack(instance: ServerInstance, pack: ParsedPack, java: JavaPlan, notes: string[] = []): string {
	return startTask(
		{ label: `Install ${pack.name}`, instanceId: instance.id },
		(task) => endJournalOnFailure(instance.id, async () => {
			for (const note of notes) task.log(note);
			task.setProgress(null, 'Resolving Java');
			const javaPath = await obtainJava(java, javaTarget(instance), task);

			// The instance row, not the pack, decides the loader: a Forge 1.12.2
			// pack can be installed onto Cleanroom instead.
			task.setProgress(null, `Installing ${instance.modloader}`);
			const loader = getLoader(instance.modloader);
			const result = await loader.install({
				dir: instance.path,
				minecraftVersion: instance.minecraftVersion,
				loaderVersion: instance.modloaderVersion,
				javaPath,
				task
			});

			// The overrides first: they say where the pack's world files belong.
			await loadOverridesArchive(pack, task);
			// The server ends up with the pack's server.properties, so its world is
			// the pack's level-name; files the pack ships under another world
			// folder are moved onto it.
			const packWorld = packWorldName(pack);
			const serverWorld = packLevelName(pack) ?? 'world';
			const toWorld = (rel: string) => mapWorldPath(rel, packWorld, serverWorld);

			task.setProgress(0, 'Downloading mods');
			const { failures } = await downloadPackFiles(
				{ ...pack, downloads: pack.downloads.map((d) => (d.target ? { ...d, target: toWorld(d.target) } : d)) },
				instance.path,
				task
			);

			const copied = await applyOverrides(pack, instance.path, toWorld);
			if (copied) task.log(`Copied ${copied} files from the pack's overrides.`);

			// A pack's own server.properties (if its overrides shipped one) fully
			// replaced the file written at creation, since applyOverrides is a raw
			// copy. Backfill anything the pack's file leaves unset with our
			// defaults - the pack's own values always win, this only fills gaps -
			// so an incomplete or absent pack properties file still ends up with
			// sane values instead of blanks in the guided editor.
			const password = rconPassword(instance);
			await fillPropertyDefaults(
				instance.path,
				newServerProperties({
					port: instance.serverPort,
					rconPort: instance.rconPort,
					rconPassword: password ?? '',
					motd: instance.name,
					minecraftVersion: instance.minecraftVersion
				})
			);

			// Packs usually ship their own server.properties; re-apply the port and
			// RCON settings MineShell allocated so the server stays reachable and
			// controllable after the import overwrites them.
			await patchProperties(instance.path, {
				'server-port': String(instance.serverPort),
				'enable-rcon': 'true',
				'rcon.port': String(instance.rconPort),
				...(password ? { 'rcon.password': password } : {})
			});

			db.update(serverInstances)
				.set({
					launchArgs: result.launchArgs,
					modloaderVersion: result.loaderVersion,
					updatedAt: Date.now()
				})
				.where(eq(serverInstances.id, instance.id))
				.run();

			// Pack mods are written straight to disk by the downloader, so without
			// this they would all start life untracked and the mods page would be
			// useless until someone hit Sync by hand.
			task.setProgress(null, 'Identifying mods');
			try {
				const synced = await syncMods(requireInstance(instance.id), {
					fromPack: true,
					curseforge: curseforgeOrigins(pack),
					onProgress: (done, total) => task.setProgress((done / total) * 100, 'Identifying mods')
				});
				task.log(
					`Tracked ${synced.curseforge + synced.resolved + synced.trackedAsManual} mods ` +
						`(${synced.curseforge} from CurseForge, ${synced.resolved} identified on Modrinth, ` +
						`${synced.trackedAsManual} unrecognised).`
				);
			} catch (err) {
				// Identification is a convenience; a failure here must not undo a
				// working install.
				task.log(
					`Mod identification failed: ${err instanceof Error ? err.message : 'unknown error'}. ` +
						'Use "Sync mods with database" on the mods page to retry.'
				);
			}

			const problems = [...notes];
			if (failures.length) {
				problems.push(
					`${failures.length} mod${failures.length === 1 ? '' : 's'} could not be downloaded. Check the task log and add them by hand.`
				);
			}
			task.setProgress(null, 'Checking for client-only mods');
			try {
				const installed = (await listInstanceMods(requireInstance(instance.id))).map((m) => m.fileName);
				const clientOnly = await disableClientOnlyMods(requireInstance(instance.id), installed, task);
				const line = describeClientOnlyResult(clientOnly);
				if (line) problems.push(line);
			} catch (err) {
				// A check that could not run must not undo a working install.
				task.log(`Checking for client-only mods failed: ${err instanceof Error ? err.message : 'unknown error'}.`);
			}
			if (instance.modloader === 'cleanroom' && pack.modloader === 'forge') {
				task.setProgress(null, 'Preparing mods for Cleanroom');
				const fixes = await applyCleanroomModFixes(requireInstance(instance.id), task);
				problems.push(...fixes.failures);
			}

			await syncUnit(requireInstance(instance.id));

			commitOperation(instance.id, {
				status: 'ready',
				statusMessage: problems.length ? problems.join(' ') : null,
				// Which data packs are the pack's, for the next pack version change.
				packDatapacks: JSON.stringify(datapackNames(packWorldFiles(pack)))
			});
			audit('instance.pack_imported', { instanceId: instance.id, detail: pack.name });
			task.setProgress(100, 'Ready');
		})
	);
}

/** Create an instance from a pack MineShell fetched or built from a provider. */
export async function createFromPack(
	name: string,
	pack: ParsedPack,
	meta: { source: string; projectId?: string | null; versionId?: string | null },
	overrides: Partial<CreateInstanceInput> = {}
): Promise<{ instance: ServerInstance; taskId: string }> {
	const minecraftVersion = overrides.minecraftVersion ?? pack.minecraftVersion;
	// Cleanroom can be asked for before the pack is known (uploads), so the
	// request is dropped for anything that is not Forge 1.12.2 - with a note
	// in the task log and status, not silently. A swapped loader never
	// inherits the pack's Forge version number.
	const swapToCleanroom =
		overrides.modloader === 'cleanroom' && canUseCleanroom(pack.modloader, minecraftVersion);
	const notes =
		overrides.modloader === 'cleanroom' && !swapToCleanroom
			? [
					`Cleanroom was requested, but this pack is ${pack.modloader} for Minecraft ${minecraftVersion}, so it was installed as-is.`
				]
			: [];
	const modloader = swapToCleanroom ? 'cleanroom' : pack.modloader;
	const modloaderVersion = swapToCleanroom ? (overrides.modloaderVersion ?? null) : pack.modloaderVersion;
	const java = await planJava(
		{ minecraftVersion, modloader, modloaderVersion, explicitPath: overrides.javaPath ?? null },
		overrides.downloadJava
	);
	const instance = await insertInstanceRow({
		name: name.trim() || pack.name,
		minecraftVersion,
		modloader,
		modloaderVersion,
		memoryMinMb: overrides.memoryMinMb,
		memoryMaxMb: overrides.memoryMaxMb,
		javaPath: overrides.javaPath,
		packSource: meta.source,
		packName: pack.name,
		packProjectId: meta.projectId ?? null,
		packVersionId: meta.versionId ?? pack.version,
		packVersionName: pack.version
	});

	const taskId = provisionFromPack(instance, pack, java, notes);
	watchTaskFailure(taskId, instance.id);
	return { instance, taskId };
}

function watchTaskFailure(taskId: string, instanceId: string) {
	const check = setInterval(() => {
		const task = getTask(taskId);
		if (!task) return clearInterval(check);
		if (task.state === 'failed') {
			setStatus(instanceId, 'failed', task.error);
			clearInterval(check);
		} else if (task.state !== 'running') {
			clearInterval(check);
		}
	}, 1000);
	check.unref?.();
}

// ------------------------------------------------------ cleanroom migration ---

/**
 * Migrating keeps everything needed to go back: the Forge jar, libraries and
 * vanilla jar are moved (not deleted) into this folder, and the manifest
 * records every setting and mod the migration touched.
 */
const FORGE_BACKUP = path.join('.mineshell', 'forge-backup');

export type ForgeBackup = {
	createdAt: number;
	modloaderVersion: string | null;
	launchArgs: string;
	jvmArgs: string;
	javaPath: string | null;
	/** Entries moved out of the instance root, relative to it. */
	files: string[];
	/** Mod filenames disabled by the migration, without the .disabled suffix. */
	disabledMods: string[];
	/** Mod filenames the migration downloaded. */
	addedMods: string[];
};

function backupDir(instance: ServerInstance): string {
	return path.join(instance.path, FORGE_BACKUP);
}

export async function readForgeBackup(instance: ServerInstance): Promise<ForgeBackup | null> {
	try {
		return JSON.parse(
			await fs.readFile(path.join(backupDir(instance), 'manifest.json'), 'utf8')
		) as ForgeBackup;
	} catch {
		return null;
	}
}

async function writeForgeBackup(instance: ServerInstance, backup: ForgeBackup): Promise<void> {
	await fs.writeFile(
		path.join(backupDir(instance), 'manifest.json'),
		JSON.stringify(backup, null, 2),
		'utf8'
	);
}

/** Root entries a Forge 1.12.2 server install owns; everything else is world, config or mods. */
function isForgeInstallEntry(name: string): boolean {
	return name === 'libraries' || /^forge-.*\.jar$/.test(name) || /^minecraft_server\..*\.jar$/.test(name);
}

export function isCleanroomInstallEntry(name: string): boolean {
	return name === 'libraries' || /^cleanroom-.*\.jar$/.test(name) || /^minecraft_server\..*\.jar$/.test(name);
}

/**
 * Delete the entries in `dir` that match `test`, except those in `keep`. A
 * rollback passes the originals it never got round to moving as `keep`, so a
 * failure halfway through moving files aside cannot delete the ones still in
 * place.
 */
export async function removeEntries(
	dir: string,
	test: (name: string) => boolean,
	keep: Set<string> = new Set()
): Promise<void> {
	for (const name of await fs.readdir(dir)) {
		if (test(name) && !keep.has(name)) await fs.rm(path.join(dir, name), { recursive: true, force: true });
	}
}

/** Entries in `dir` matching `test`, for working out what a rollback must leave alone. */
export async function listEntries(dir: string, test: (name: string) => boolean): Promise<string[]> {
	return (await fs.readdir(dir)).filter(test);
}

/**
 * Puts an install that was moved aside back: whatever the new install left
 * (entries matching `test`) goes, except originals that were never moved,
 * then the moved ones return and `aside` is removed. `moved` defaults to
 * what is actually in `aside`, which is how recovery after a restart knows.
 */
export async function restoreAside(
	root: string,
	aside: string,
	before: string[],
	test: (name: string) => boolean,
	moved?: string[]
): Promise<void> {
	const back =
		moved ?? (await fs.readdir(aside).catch(() => [] as string[])).filter((n) => before.includes(n));
	await removeEntries(root, test, new Set(before.filter((n) => !back.includes(n))));
	for (const name of back) await fs.rename(path.join(aside, name), path.join(root, name));
	await fs.rm(aside, { recursive: true, force: true });
}

export async function requireStopped(instance: ServerInstance): Promise<void> {
	if (beingCopied.has(instance.id)) throw new InstanceError('This server is being copied; wait for the copy to finish.');
	const state = await unitState(instance.id);
	if (state.active !== 'inactive' && state.active !== 'failed') {
		throw new InstanceError('Stop the server first.');
	}
	if (instance.status === 'provisioning') {
		throw new InstanceError('This server is still being set up.');
	}
}

/**
 * Swap an installed Forge 1.12.2 instance onto Cleanroom. Checks that can fail
 * up front (state, Java) run before anything on disk changes; a failure during
 * the install itself puts the Forge files back before reporting it.
 */
export async function migrateToCleanroom(
	instance: ServerInstance,
	loaderVersion: string | null,
	opts: { snapshot?: boolean; downloadJava?: JavaVendor } = {}
): Promise<string> {
	if (!canUseCleanroom(instance.modloader, instance.minecraftVersion)) {
		throw new InstanceError('Only Forge 1.12.2 servers can move to Cleanroom.');
	}
	await requireStopped(instance);
	if (await readForgeBackup(instance)) {
		throw new InstanceError(
			`A Forge backup already exists in ${FORGE_BACKUP}. Move or delete it before migrating again.`
		);
	}

	// An instance pinned to Java 8 (normal for Forge 1.12.2) cannot run
	// Cleanroom; the pin is dropped for auto-matching and restored on revert.
	const pinned = instance.javaPath
		? listJavaRuntimes().find((j) => j.path === instance.javaPath)
		: undefined;
	const target = { ...instance, modloader: 'cleanroom', modloaderVersion: loaderVersion };
	let java = resolveJava({ ...target, explicitPath: instance.javaPath });
	const keepPin = !!java.path && !java.warning && instance.javaPath !== null;
	if (!keepPin) java = resolveJava({ ...target, explicitPath: null });
	const javaTargetAfter = javaTarget({ ...target, javaPath: keepPin ? instance.javaPath : null });
	const javaPlan: JavaPlan = java.path
		? { path: java.path }
		: await planJava(javaTargetAfter, opts.downloadJava);

	const forgeBefore = await listEntries(instance.path, isForgeInstallEntry);
	journal(instance.id, { kind: 'cleanroom-migration', backup: FORGE_BACKUP, before: forgeBefore });
	setStatus(instance.id, 'provisioning', 'Migrating to Cleanroom');
	const taskId = startTask(
		{ label: `Migrate ${instance.name} to Cleanroom`, instanceId: instance.id },
		async (task) => {
			const backup: ForgeBackup = {
				createdAt: Date.now(),
				modloaderVersion: instance.modloaderVersion,
				launchArgs: instance.launchArgs,
				jvmArgs: instance.jvmArgs,
				javaPath: instance.javaPath,
				files: [],
				disabledMods: [],
				addedMods: []
			};
			const dir = backupDir(instance);
			try {
				if (opts.snapshot) {
					await snapshotStep(instance, { reason: 'cleanroom-migration', label: `Before moving to Cleanroom ${loaderVersion ?? '(latest)'}` }, task);
				}
				const javaPath = await obtainJava(javaPlan, javaTargetAfter, task);
				task.setProgress(null, 'Backing up Forge');
				await fs.mkdir(dir, { recursive: true });
				for (const name of forgeBefore) {
					await fs.rename(path.join(instance.path, name), path.join(dir, name));
					backup.files.push(name);
				}
				task.log(`Moved ${backup.files.join(', ') || 'nothing'} to ${FORGE_BACKUP}.`);
				await writeForgeBackup(instance, backup);

				task.setProgress(null, 'Installing Cleanroom');
				const result = await getLoader('cleanroom').install({
					dir: instance.path,
					minecraftVersion: instance.minecraftVersion,
					loaderVersion,
					javaPath,
					task
				});

				const legacy = stripJava8OnlyFlags(instance.jvmArgs);
				if (legacy.removed.length) {
					task.log(`Removed Java 8-only JVM flags: ${legacy.removed.join(' ')}`);
				}
				if (pinned && !keepPin) {
					task.log(`Unpinned Java ${pinned.majorVersion}; Java ${java.requiredMajor} is matched automatically now.`);
				}

				commitOperation(instance.id, {
					modloader: 'cleanroom',
					modloaderVersion: result.loaderVersion,
					launchArgs: result.launchArgs,
					jvmArgs: legacy.flags,
					javaPath: keepPin ? instance.javaPath : null
				});
			} catch (err) {
				task.log('Install failed; putting the Forge files back.');
				await restoreAside(instance.path, dir, forgeBefore, isCleanroomInstallEntry, backup.files);
				endOperation(instance.id);
				setStatus(
					instance.id,
					'ready',
					`Cleanroom migration failed and was rolled back: ${err instanceof Error ? err.message : 'unknown error'}`
				);
				throw err;
			}

			// Past this point the server runs Cleanroom; mod problems are
			// reported, not rolled back, and the unit is synced regardless.
			let problems: string[] = [];
			try {
				task.setProgress(null, 'Preparing mods for Cleanroom');
				const fixes = await applyCleanroomModFixes(requireInstance(instance.id), task);
				backup.disabledMods = fixes.disabled;
				backup.addedMods = fixes.added;
				await writeForgeBackup(instance, backup);
				problems = fixes.failures;
			} catch (err) {
				problems = [
					`Cleanroom is installed, but preparing the mods failed: ${err instanceof Error ? err.message : 'unknown error'}. Check the task log.`
				];
				task.log(problems[0]);
			} finally {
				await syncUnit(requireInstance(instance.id));
			}
			setStatus(instance.id, 'ready', problems.length ? problems.join(' ') : null);
			audit('instance.migrated_cleanroom', { instanceId: instance.id, detail: loaderVersion ?? 'latest' });
			task.setProgress(100, 'Ready');
		}
	);
	return taskId;
}

/** Undo migrateToCleanroom from its backup. */
export async function revertToForge(instance: ServerInstance, opts: { snapshot?: boolean } = {}): Promise<string> {
	if (instance.modloader !== 'cleanroom') {
		throw new InstanceError('This server is not running Cleanroom.');
	}
	await requireStopped(instance);
	const backup = await readForgeBackup(instance);
	if (!backup) {
		throw new InstanceError('There is no Forge backup for this server to go back to.');
	}

	journal(instance.id, { kind: 'cleanroom-revert' });
	setStatus(instance.id, 'provisioning', 'Reverting to Forge');
	const taskId = startTask(
		{ label: `Revert ${instance.name} to Forge`, instanceId: instance.id },
		// Retry-safe, so a failure (or a restart) just leaves it to be run again.
		(task) => endJournalOnFailure(instance.id, async () => {
			const dir = backupDir(instance);
			if (opts.snapshot) {
				await snapshotStep(instance, { reason: 'cleanroom-revert', label: `Before reverting to Forge ${backup.modloaderVersion ?? ''}`.trim() }, task);
			}
			task.setProgress(null, 'Restoring Forge');
			// A previous revert that failed part-way already moved some entries
			// back; they are no longer in the backup and must not be deleted as
			// "Cleanroom files" (libraries/ and the vanilla jar match both).
			const stillBackedUp = new Set(await fs.readdir(dir).catch(() => [] as string[]));
			const alreadyRestored = new Set(backup.files.filter((name) => !stillBackedUp.has(name)));
			await removeEntries(instance.path, isCleanroomInstallEntry, alreadyRestored);
			for (const name of backup.files) {
				if (!stillBackedUp.has(name)) continue;
				await fs.rename(path.join(dir, name), path.join(instance.path, name));
			}

			task.setProgress(null, 'Restoring mods');
			const modDir = path.join(instance.path, 'mods');
			const present = new Set(await fs.readdir(modDir).catch(() => [] as string[]));
			for (const name of backup.disabledMods) {
				if (present.has(`${name}${DISABLED_SUFFIX}`)) {
					await setModEnabled(instance, `${name}${DISABLED_SUFFIX}`, true);
					task.log(`Re-enabled ${name}`);
				}
			}
			for (const name of backup.addedMods) {
				if (present.has(name)) {
					await deleteMod(instance, name);
					task.log(`Removed ${name}`);
				}
			}

			commitOperation(instance.id, {
				modloader: 'forge',
				modloaderVersion: backup.modloaderVersion,
				launchArgs: backup.launchArgs,
				jvmArgs: backup.jvmArgs,
				javaPath: backup.javaPath
			});
			await fs.rm(dir, { recursive: true, force: true });

			await syncUnit(requireInstance(instance.id));
			setStatus(instance.id, 'ready', null);
			audit('instance.reverted_forge', { instanceId: instance.id });
			task.setProgress(100, 'Ready');
		})
	);
	// Unlike migration there is no further fallback here, so a failure is left
	// visible on the instance for a manual look.
	watchTaskFailure(taskId, instance.id);
	return taskId;
}

// ---------------------------------------------------- loader version change ---

/**
 * Root entries a loader install creates, for every loader MineShell installs:
 * the libraries tree, the loader/launcher/vanilla jars and modern Forge's run
 * scripts. Worlds, configs, mods and anything else are never matched.
 */
export function isLoaderInstallEntry(name: string): boolean {
	return (
		['libraries', '.fabric', 'run.sh', 'run.bat', 'user_jvm_args.txt'].includes(name) ||
		/^(server|quilt-server-launch|fabric-server-launch|minecraft_server\..*|(forge|neoforge|cleanroom)-.*)\.jar$/.test(name) ||
		// An installer's log lands in the server folder (and is left there if it fails).
		/^(forge|neoforge|cleanroom)-.*-installer\.jar\.log$/.test(name)
	);
}

/**
 * Reinstall the instance's loader at another version, in place. The current
 * install is moved aside first and only deleted once the new one has
 * installed; a failed install puts it back. Previously the version field
 * only relabelled the instance.
 */
export async function changeLoaderVersion(
	instance: ServerInstance,
	loaderVersion: string | null,
	opts: { snapshot?: boolean; downloadJava?: JavaVendor } = {}
): Promise<string> {
	const loader = getLoader(instance.modloader);
	if (instance.modloader === 'vanilla') {
		throw new InstanceError('Vanilla has no loader version to change.');
	}
	await requireStopped(instance);

	// A different loader version can need a different Java (Cleanroom 0.4 runs
	// on 21, 0.5+ on 25), so resolve for the target before touching anything.
	const target = javaTarget({ ...instance, modloaderVersion: loaderVersion });
	const javaPlan = await planJava(target, opts.downloadJava);
	// A pin to the wrong Java is the person's to change, not something to download around.
	const pinnedWarning = instance.javaPath ? resolveJava(target).warning : null;
	if (pinnedWarning) throw new InstanceError(pinnedWarning);
	const from = instance.modloaderVersion ?? 'unknown';
	const asideRel = path.join('.mineshell', `loader-previous-${Date.now()}`);
	const before = await listEntries(instance.path, isLoaderInstallEntry);
	journal(instance.id, { kind: 'loader-change', aside: asideRel, before });

	setStatus(instance.id, 'provisioning', `Installing ${loader.label} ${loaderVersion ?? '(latest)'}`);
	const taskId = startTask(
		{ label: `Change ${instance.name} to ${loader.label} ${loaderVersion ?? '(latest)'}`, instanceId: instance.id },
		async (task) => {
			const aside = path.join(instance.path, asideRel);
			const moved: string[] = [];
			try {
				const javaPath = await obtainJava(javaPlan, target, task);
				if (opts.snapshot) {
					await snapshotStep(instance, { reason: 'loader-change', label: `Before changing ${loader.label} ${from} to ${loaderVersion ?? '(latest)'}` }, task);
				}
				task.setProgress(null, `Moving ${loader.label} ${from} aside`);
				await fs.mkdir(aside, { recursive: true });
				for (const name of before) {
					await fs.rename(path.join(instance.path, name), path.join(aside, name));
					moved.push(name);
				}

				task.setProgress(null, `Installing ${loader.label} ${loaderVersion ?? '(latest)'}`);
				const result = await loader.install({
					dir: instance.path,
					minecraftVersion: instance.minecraftVersion,
					loaderVersion,
					javaPath,
					task
				});

				commitOperation(instance.id, {
					modloaderVersion: result.loaderVersion,
					launchArgs: result.launchArgs
				});
				await fs.rm(aside, { recursive: true, force: true });
				task.log(`Switched ${loader.label} ${from} -> ${result.loaderVersion ?? 'latest'}.`);

				if (
					instance.modloader === 'cleanroom' &&
					cleanroomJavaMajor(instance.modloaderVersion) !== cleanroomJavaMajor(result.loaderVersion)
				) {
					task.log(
						`Cleanroom moved from Java ${cleanroomJavaMajor(instance.modloaderVersion)} to Java ${cleanroomJavaMajor(result.loaderVersion)}. Fugue builds are tied to one or the other; swap Fugue to a matching version if the server fails to start.`
					);
				}
			} catch (err) {
				task.log(`Install failed; restoring ${loader.label} ${from}.`);
				// Whatever the failed install left behind goes, then the old files return.
				await restoreAside(instance.path, aside, before, isLoaderInstallEntry, moved);
				endOperation(instance.id);
				setStatus(
					instance.id,
					'ready',
					`Changing the loader version failed and ${loader.label} ${from} was restored: ${err instanceof Error ? err.message : 'unknown error'}`
				);
				throw err;
			}

			await syncUnit(requireInstance(instance.id));
			setStatus(instance.id, 'ready', null);
			audit('instance.loader_version_changed', {
				instanceId: instance.id,
				detail: `${from} -> ${loaderVersion ?? 'latest'}`
			});
			task.setProgress(100, 'Ready');
		}
	);
	return taskId;
}

// ---------------------------------------------------------------- lifecycle ---

export async function acceptEula(instance: ServerInstance): Promise<void> {
	await fs.writeFile(
		path.join(instance.path, 'eula.txt'),
		`#Accepted through MineShell on ${new Date().toISOString()}\n#https://aka.ms/MinecraftEULA\neula=true\n`,
		'utf8'
	);
	db.update(serverInstances)
		.set({ eulaAccepted: true, updatedAt: Date.now() })
		.where(eq(serverInstances.id, instance.id))
		.run();
	audit('instance.eula_accepted', { instanceId: instance.id });
}

export async function eulaIsAccepted(instance: ServerInstance): Promise<boolean> {
	try {
		const text = await fs.readFile(path.join(instance.path, 'eula.txt'), 'utf8');
		return /^\s*eula\s*=\s*true/im.test(text);
	} catch {
		return false;
	}
}

export async function start(instance: ServerInstance): Promise<{ ok: boolean; message: string }> {
	if (!(await eulaIsAccepted(instance))) {
		return { ok: false, message: 'Accept the Minecraft EULA before starting this server.' };
	}
	if (instance.status === 'provisioning') {
		return { ok: false, message: 'This instance is still being set up.' };
	}
	if (beingCopied.has(instance.id)) {
		return { ok: false, message: 'This server is being copied; start it once the copy has finished.' };
	}
	// Ports are only checked against what MineShell itself has assigned at
	// creation time. Anything can claim the port afterwards - another
	// service, a manually-started server - and systemd reports the start as
	// requested regardless, since it is the Minecraft process, not systemd,
	// that fails to bind. Catch that here instead of leaving it to look like
	// an unexplained crash right after starting.
	if (!(await portIsFree(instance.serverPort))) {
		return {
			ok: false,
			message: `Port ${instance.serverPort} is already in use by something else. Free it, or change this instance's port in Settings, then try again.`
		};
	}
	if (!(await portIsFree(instance.rconPort))) {
		return {
			ok: false,
			message: `RCON port ${instance.rconPort} is already in use by something else. Free it, or change this instance's port in Settings, then try again.`
		};
	}
	clearStopIntent(instance.id);
	const sync = await syncUnit(instance);
	await resetFailed(instance.id);
	const res = await startUnit(instance.id);
	if (res.code !== 0) {
		return { ok: false, message: res.stderr.trim() || `systemctl start ${unitName(instance.id)} failed.` };
	}
	audit('instance.start', { instanceId: instance.id });
	return { ok: true, message: sync.warning ?? 'Starting.' };
}

/**
 * A graceful stop goes through RCON so the world saves and players see a clean
 * disconnect. systemd's SIGTERM is the fallback, and also the path when RCON is
 * unreachable because the server is still booting.
 */
/**
 * Stops MineShell asked for, so a deliberate stop is not later mistaken for a
 * crash. systemd reports a hard stop with the same Result values as a real
 * failure (a JVM killed mid-shutdown exits non-zero either way), so intent
 * cannot be recovered from the unit afterwards - it has to be remembered at
 * the moment the request is made. Cleared once the stop is observed.
 */
const intentionalStops = new Map<string, number>();
const STOP_INTENT_TTL_MS = 5 * 60_000;

export function wasStopIntentional(id: string): boolean {
	const at = intentionalStops.get(id);
	if (!at) return false;
	if (Date.now() - at > STOP_INTENT_TTL_MS) {
		intentionalStops.delete(id);
		return false;
	}
	return true;
}

export function clearStopIntent(id: string): void {
	intentionalStops.delete(id);
}

export async function stop(
	instance: ServerInstance,
	opts: { graceful?: boolean } = {}
): Promise<{ ok: boolean; message: string }> {
	intentionalStops.set(instance.id, Date.now());
	const password = rconPassword(instance);
	if (opts.graceful !== false && password) {
		try {
			await rconExec({ port: instance.rconPort, password }, ['save-all', 'stop']);
			audit('instance.stop', { instanceId: instance.id, detail: 'rcon' });
			// systemd still needs to reap the unit once the JVM exits.
			setTimeout(() => void stopUnit(instance.id), 20_000);
			return { ok: true, message: 'Saving and shutting down.' };
		} catch {
			/* fall through to SIGTERM */
		}
	}
	const res = await stopUnit(instance.id);
	audit('instance.stop', { instanceId: instance.id, detail: 'systemd' });
	return {
		ok: res.code === 0,
		message: res.code === 0 ? 'Stopping.' : res.stderr.trim() || 'Stop failed.'
	};
}

export async function restart(instance: ServerInstance): Promise<{ ok: boolean; message: string }> {
	if (!(await eulaIsAccepted(instance))) {
		return { ok: false, message: 'Accept the Minecraft EULA before starting this server.' };
	}
	clearStopIntent(instance.id);
	await syncUnit(instance);
	const res = await restartUnit(instance.id);
	audit('instance.restart', { instanceId: instance.id });
	return {
		ok: res.code === 0,
		message: res.code === 0 ? 'Restarting.' : res.stderr.trim() || 'Restart failed.'
	};
}

export async function sendCommand(instance: ServerInstance, command: string): Promise<string> {
	const password = rconPassword(instance);
	if (!password) throw new InstanceError('No RCON password is set for this instance.');
	const [response] = await rconExec({ port: instance.rconPort, password }, [command]);
	return response;
}

export async function onlinePlayers(
	instance: ServerInstance
): Promise<{ online: number; max: number; names: string[] } | null> {
	const password = rconPassword(instance);
	if (!password) return null;
	try {
		const [raw] = await rconExec({ port: instance.rconPort, password }, ['list']);
		return parsePlayerList(raw);
	} catch {
		return null;
	}
}

export async function deleteInstance(
	instance: ServerInstance,
	opts: { deleteFiles: boolean }
): Promise<void> {
	await stopUnit(instance.id).catch(() => undefined);
	await removeUnitArtifacts(instance.id);
	diskUsage.delete(instance.path);
	if (opts.deleteFiles) {
		// Guard against a hand-edited path pointing somewhere unfortunate.
		const resolved = path.resolve(instance.path);
		if (resolved.startsWith(path.resolve(INSTANCES_DIR) + path.sep)) {
			await fs.rm(resolved, { recursive: true, force: true });
		}
	}
	db.delete(serverInstances).where(eq(serverInstances.id, instance.id)).run();
	audit('instance.deleted', {
		instanceId: instance.id,
		detail: opts.deleteFiles ? 'files removed' : 'files kept'
	});
}

// ------------------------------------------------------------------ summary ---

export type InstanceSummary = {
	instance: ServerInstance;
	state: UnitState;
	running: boolean;
	uptimeMs: number;
	javaWarning: string | null;
	eulaAccepted: boolean;
};

// -------------------------------------------------------------------- clone ---

/**
 * Servers whose folder a clone is copying. Kept in memory only: a clone
 * that MineShell's stopping cuts short stops copying too.
 */
const beingCopied = new Set<string>();

/**
 * What a clone leaves out of `.mineshell/`: the source's world snapshots
 * (the clone starts its own history) and whatever an operation left behind.
 * The Forge backup of a Cleanroom server is kept, so the copy can revert.
 */
export function cloneSkips(relative: string): boolean {
	const rel = relative.split(path.sep).join('/');
	return (
		rel === '.mineshell/snapshots' ||
		/^\.mineshell\/(pack-change|loader-previous|world-previous|world-incoming)-\d+$/.test(rel) ||
		/^\.mineshell\/[^/]*installer\.jar(\.log|\.part)?$/.test(rel)
	);
}

/**
 * Copy a stopped server - folder, settings and mod records - under a new
 * name with its own ports and RCON password, to try a pack update or a
 * migration on the copy first. Journalled like a first install: a copy cut
 * short is marked failed, to be deleted.
 */
export async function cloneInstance(
	source: ServerInstance,
	name: string
): Promise<{ instance: ServerInstance; taskId: string }> {
	if (!name.trim()) throw new InstanceError('Give the copy a name.');
	await requireStopped(source);

	// The id names the folder too; a deleted server's kept files must not be adopted.
	const taken = async (candidate: string) =>
		!!getInstance(candidate) || (await fs.access(instanceDir(candidate)).then(() => true, () => false));
	const base = slugify(name);
	let id = base;
	for (let n = 2; await taken(id); n++) id = `${base}-${n}`;
	const dir = instanceDir(id);
	const { serverPort, rconPort } = await allocatePortPair();
	const password = randomPassword();
	const now = Date.now();
	db.insert(serverInstances)
		.values({
			...source,
			id,
			name: name.trim(),
			path: dir,
			serverPort,
			rconPort,
			rconPasswordEnc: encryptSecret(password),
			pinned: false,
			restartNextAt: null,
			status: 'provisioning',
			statusMessage: `Copying ${source.name}`,
			createdAt: now,
			updatedAt: now
		})
		.run();
	beginOperation(id, { kind: 'create' });
	beingCopied.add(source.id);

	const taskId = startTask(
		{ label: `Copy ${source.name} to ${name.trim()}`, instanceId: id },
		(task) =>
			endJournalOnFailure(id, async () => {
				task.setProgress(null, 'Copying files');
				await fs.cp(source.path, dir, {
					recursive: true,
					errorOnExist: true,
					force: false,
					preserveTimestamps: true,
					mode: fsConstants.COPYFILE_FICLONE,
					filter: (from) => !cloneSkips(path.relative(source.path, from))
				});
				beingCopied.delete(source.id);

				task.setProgress(null, 'Setting up the copy');
				const copy = requireInstance(id);
				await syncPortsToProperties(copy);
				const rows = db.select().from(instanceMods).where(eq(instanceMods.instanceId, source.id)).all();
				for (const { id: _rowId, ...row } of rows) {
					db.insert(instanceMods).values({ ...row, instanceId: id }).run();
				}
				await syncUnit(copy);
				commitOperation(id, { status: 'ready', statusMessage: null });
				audit('instance.cloned', { instanceId: id, detail: source.id });
				task.log(`Copied ${source.name}; the copy listens on port ${serverPort} (RCON ${rconPort}).`);
				task.setProgress(100, 'Ready');
			}).finally(() => beingCopied.delete(source.id))
	);
	watchTaskFailure(taskId, id);
	return { instance: requireInstance(id), taskId };
}

export async function summarise(instance: ServerInstance): Promise<InstanceSummary> {
	const state = await unitState(instance.id);
	const java = resolveJava({
		explicitPath: instance.javaPath,
		minecraftVersion: instance.minecraftVersion,
		modloader: instance.modloader,
		modloaderVersion: instance.modloaderVersion
	});
	const running = state.active === 'active';
	return {
		instance,
		state,
		running,
		uptimeMs: running && state.activeEnterTimestamp ? Date.now() - state.activeEnterTimestamp : 0,
		javaWarning: java.warning,
		eulaAccepted: await eulaIsAccepted(instance)
	};
}

export async function summariseAll(): Promise<InstanceSummary[]> {
	const list = listInstances();
	const summaries = await Promise.all(list.map(summarise));
	return summaries.sort((a, b) => {
		if (a.instance.pinned !== b.instance.pinned) return a.instance.pinned ? -1 : 1;
		if (a.running !== b.running) return a.running ? -1 : 1;
		return a.instance.name.localeCompare(b.instance.name);
	});
}

const DISK_USAGE_TTL_MS = 60_000;
const diskUsage = new Map<string, { at: number; bytes: number; refreshing: boolean }>();

/**
 * Walking a big pack (tens of thousands of files) takes a noticeable moment,
 * and the overview asks every few seconds. Only the first ask waits; after
 * that the last measurement is returned and refreshed in the background
 * once it is a minute old.
 */
export async function instanceDiskUsage(instance: ServerInstance): Promise<number> {
	const hit = diskUsage.get(instance.path);
	if (!hit) {
		const bytes = await directorySize(instance.path);
		diskUsage.set(instance.path, { at: Date.now(), bytes, refreshing: false });
		return bytes;
	}
	if (!hit.refreshing && Date.now() - hit.at > DISK_USAGE_TTL_MS) {
		hit.refreshing = true;
		void directorySize(instance.path)
			.then((bytes) => diskUsage.set(instance.path, { at: Date.now(), bytes, refreshing: false }))
			.catch(() => (hit.refreshing = false));
	}
	return hit.bytes;
}

/** Keep server.properties and the DB row agreeing about ports and RCON. */
export async function syncPortsToProperties(instance: ServerInstance): Promise<void> {
	const password = rconPassword(instance);
	await patchProperties(instance.path, {
		'server-port': String(instance.serverPort),
		'query.port': String(instance.serverPort),
		'enable-rcon': 'true',
		'rcon.port': String(instance.rconPort),
		...(password ? { 'rcon.password': password } : {})
	});
}

export async function currentProperties(instance: ServerInstance) {
	return readProperties(instance.path);
}
