import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { auditLog, serverInstances, type ServerInstance } from './db/schema';
import { INSTANCES_DIR, instanceDir, unitName } from './config';
import { decryptSecret, encryptSecret, randomPassword } from './crypto';
import { BUILT_IN_PRESETS, composeJvmArgs, getPreset } from './jvm-presets';
import { allocatePortPair, portIsFree } from './ports';
import {
	defaultProperties,
	fillPropertyDefaults,
	patchProperties,
	readProperties,
	writeProperties
} from './properties';
import { resolveJava, scanJavaRuntimes } from './java';
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
import { getTask, startTask } from './tasks';
import { getLoader, type ModloaderId } from './modloaders';
import { applyOverrides, downloadPackFiles, loadOverridesArchive, parsePack, type ParsedPack } from './packs';
import { syncMods } from './mods';
import { directorySize } from './files';

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
		modloader: instance.modloader
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
};

function jvmArgsFor(minMb: number, maxMb: number): string {
	// The default preset, so a new instance starts from something that is still
	// reselectable later rather than a one-off string.
	const preset = getPreset('aikar') ?? BUILT_IN_PRESETS[0];
	return composeJvmArgs(preset.flags, minMb, maxMb);
}

async function insertInstanceRow(
	input: CreateInstanceInput & { packSource?: string | null; packName?: string | null; packProjectId?: string | null; packVersionId?: string | null }
): Promise<ServerInstance> {
	const id = uniqueId(input.name);
	const dir = instanceDir(id);
	await fs.mkdir(path.join(dir, 'mods'), { recursive: true });
	await fs.mkdir(path.join(dir, '.mineshell'), { recursive: true });

	const { serverPort, rconPort } = await allocatePortPair();
	const password = randomPassword();
	const minMb = input.memoryMinMb ?? 1024;
	const maxMb = input.memoryMaxMb ?? 4096;
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
			launchArgs: '-jar server.jar nogui',
			jvmArgs: jvmArgsFor(minMb, maxMb),
			memoryMinMb: minMb,
			memoryMaxMb: maxMb,
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

	await writeProperties(
		dir,
		defaultProperties({
			port: serverPort,
			rconPort,
			rconPassword: password,
			motd: input.name.trim(),
			minecraftVersion: input.minecraftVersion
		})
	);

	return requireInstance(id);
}

function setStatus(id: string, status: string, message: string | null) {
	db.update(serverInstances)
		.set({ status, statusMessage: message, updatedAt: Date.now() })
		.where(eq(serverInstances.id, id))
		.run();
}

async function resolveJavaForInstall(instance: ServerInstance): Promise<string> {
	let java = resolveJava({
		explicitPath: instance.javaPath,
		minecraftVersion: instance.minecraftVersion,
		modloader: instance.modloader
	});
	if (!java.path) {
		// First run on a fresh box often has an empty java table.
		await scanJavaRuntimes();
		java = resolveJava({
			explicitPath: instance.javaPath,
			minecraftVersion: instance.minecraftVersion,
			modloader: instance.modloader
		});
	}
	if (!java.path) {
		throw new InstanceError(
			java.warning ?? `No Java ${java.requiredMajor} runtime is available on this machine.`
		);
	}
	return java.path;
}

/** Create an instance with only a mod loader installed. */
export function createFromLoader(input: CreateInstanceInput): Promise<{ instance: ServerInstance; taskId: string }> {
	return insertInstanceRow(input).then((instance) => {
		const taskId = startTask(
			{ label: `Create ${instance.name}`, instanceId: instance.id },
			async (task) => {
				task.setProgress(null, 'Resolving Java');
				const javaPath = await resolveJavaForInstall(instance);

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

				await syncUnit(requireInstance(instance.id));
				setStatus(instance.id, 'ready', null);
				audit('instance.created', { instanceId: instance.id, detail: input.modloader });
				task.setProgress(100, 'Ready');
			}
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
function provisionFromPack(instance: ServerInstance, pack: ParsedPack): string {
	return startTask(
		{ label: `Install ${pack.name}`, instanceId: instance.id },
		async (task) => {
			task.setProgress(null, 'Resolving Java');
			const javaPath = await resolveJavaForInstall(instance);

			task.setProgress(null, `Installing ${pack.modloader}`);
			const loader = getLoader(pack.modloader);
			const result = await loader.install({
				dir: instance.path,
				minecraftVersion: instance.minecraftVersion,
				loaderVersion: pack.modloaderVersion,
				javaPath,
				task
			});

			task.setProgress(0, 'Downloading mods');
			const { failures } = await downloadPackFiles(pack, instance.path, task);
			await loadOverridesArchive(pack, task);

			const copied = await applyOverrides(pack, instance.path);
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
				defaultProperties({
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
					onProgress: (done, total) => task.setProgress((done / total) * 100, 'Identifying mods')
				});
				task.log(
					`Tracked ${synced.resolved + synced.trackedAsManual} mods ` +
						`(${synced.resolved} identified, ${synced.trackedAsManual} unrecognised).`
				);
			} catch (err) {
				// Identification is a convenience; a failure here must not undo a
				// working install.
				task.log(
					`Mod identification failed: ${err instanceof Error ? err.message : 'unknown error'}. ` +
						'Use "Sync mods with database" on the mods page to retry.'
				);
			}

			await syncUnit(requireInstance(instance.id));

			setStatus(
				instance.id,
				'ready',
				failures.length
					? `${failures.length} mod${failures.length === 1 ? '' : 's'} could not be downloaded. Check the task log and add them by hand.`
					: null
			);
			audit('instance.pack_imported', { instanceId: instance.id, detail: pack.name });
			task.setProgress(100, 'Ready');
		}
	);
}

/** Create an instance from a pack MineShell fetched or built from a provider. */
export async function createFromPack(
	name: string,
	pack: ParsedPack,
	meta: { source: string; projectId?: string | null; versionId?: string | null },
	overrides: Partial<CreateInstanceInput> = {}
): Promise<{ instance: ServerInstance; taskId: string }> {
	const instance = await insertInstanceRow({
		name: name.trim() || pack.name,
		minecraftVersion: overrides.minecraftVersion ?? pack.minecraftVersion,
		modloader: overrides.modloader ?? pack.modloader,
		modloaderVersion: overrides.modloaderVersion ?? pack.modloaderVersion,
		memoryMinMb: overrides.memoryMinMb,
		memoryMaxMb: overrides.memoryMaxMb,
		javaPath: overrides.javaPath,
		packSource: meta.source,
		packName: pack.name,
		packProjectId: meta.projectId ?? null,
		packVersionId: meta.versionId ?? pack.version
	});

	const taskId = provisionFromPack(instance, pack);
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

export async function summarise(instance: ServerInstance): Promise<InstanceSummary> {
	const state = await unitState(instance.id);
	const java = resolveJava({
		explicitPath: instance.javaPath,
		minecraftVersion: instance.minecraftVersion,
		modloader: instance.modloader
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

export async function instanceDiskUsage(instance: ServerInstance): Promise<number> {
	return directorySize(instance.path);
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
