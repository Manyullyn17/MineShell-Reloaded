import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings, type ServerInstance } from './db/schema';
import { DATA_DIR, INSTANCES_DIR } from './config';
import { bus } from './events';
import { audit, getInstance, InstanceError, listInstances } from './instances';
import { listOperations } from './operations';
import { notify } from './notifications';
import { startTask, type TaskHandle } from './tasks';
import {
	freeSpace,
	getSnapshotPolicy,
	isSnapshotId,
	listSnapshots,
	MANIFEST,
	partialPath,
	snapshotPath,
	type Snapshot
} from './snapshots';
import { formatBytes } from '#lib/shared/format.js';
import { BACKUP_COPY_CHOICES, type BackupCopy } from '#lib/shared/backups.js';

/**
 * Copies of finished snapshots in another place than the server's disk: a
 * folder on this machine to start with (another disk, a mounted NAS share, a
 * USB drive). A snapshot is already a consistent copy of the world, so a
 * running server needs no second save pause; the copy happens after the
 * snapshot is finished, and its failure never fails the snapshot.
 *
 * A destination is a kind of store with a few operations (list, write, read,
 * remove); other kinds (rclone, S3, SFTP) would be more stores, nothing else.
 * On a folder each server has a folder named by its id, holding snapshots in
 * the same shape as `.mineshell/snapshots/`: written as `<id>.partial` and
 * renamed when complete. A destination folder that is not there is never
 * created: an unmounted drive would fill the disk under its mount point.
 *
 * What is wanted there is worked out each time from both sides (`planBackup`),
 * so a copy cut short by a restart, or one that failed, is made at the next
 * sync: after every snapshot, once after MineShell starts, and every hour for
 * servers whose last copy failed.
 */

// ------------------------------------------------------------ settings ---

export type BackupDestination = { id: string; name: string; kind: 'folder'; path: string };

/** A server's backup copies: where to, which snapshots, how many kept there. */
export type ServerBackup = { destination: string | null; copy: BackupCopy; keep: number };

export const DEFAULT_SERVER_BACKUP: ServerBackup = { destination: null, copy: 'all', keep: 10 };
export const KEEP_LIMITS: [number, number] = [1, 1000];

/** What the last sync of a server said; kept so the pages can show it after a restart. */
export type BackupResult = { at: number; ok: boolean; message: string; destination: string };

const DESTINATIONS_KEY = 'backups.destinations';
const serverKey = (instanceId: string) => `backups.server:${instanceId}`;
const resultKey = (instanceId: string) => `backups.last:${instanceId}`;

function readJson(key: string): unknown {
	const row = db.select().from(settings).where(eq(settings.key, key)).get();
	try {
		return row ? JSON.parse(row.value) : null;
	} catch {
		return null;
	}
}

function writeJson(key: string, value: unknown): void {
	const text = JSON.stringify(value);
	db.insert(settings).values({ key, value: text }).onConflictDoUpdate({ target: settings.key, set: { value: text } }).run();
}

export function listDestinations(): BackupDestination[] {
	const raw = readJson(DESTINATIONS_KEY);
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(d): d is BackupDestination =>
			!!d && typeof d.id === 'string' && typeof d.name === 'string' && d.kind === 'folder' && typeof d.path === 'string' && path.isAbsolute(d.path)
	);
}

export function getDestination(id: string | null): BackupDestination | null {
	return id ? (listDestinations().find((d) => d.id === id) ?? null) : null;
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

/**
 * Why `dir` cannot be a backup folder, or null. It has to exist already (an
 * unmounted drive's mount point is an empty folder; MineShell never makes
 * one), be writable, and be apart from MineShell's own data both ways.
 * `added`: the folder is one already in the list, so missing means unmounted.
 */
export async function folderProblem(dir: string, opts: { added?: boolean } = {}): Promise<string | null> {
	if (!path.isAbsolute(dir)) return 'Give the full path of the folder, starting with /.';
	const resolved = path.resolve(dir);
	if (resolved === path.parse(resolved).root) return 'Pick a folder, not the whole file system.';
	const data = path.resolve(DATA_DIR);
	if (inside(resolved, data)) return "That is inside MineShell's own data folder; pick a folder on another disk.";
	if (inside(data, resolved)) return "MineShell's data folder is inside that one; pick a folder of its own.";
	const stat = await fs.stat(resolved).catch(() => null);
	if (!stat) {
		return opts.added
			? 'The folder is not there: is the drive mounted, or the share connected? MineShell does not make it, so nothing is written to the disk underneath.'
			: 'There is no such folder. Make it first (and mount the drive, if it is on one); MineShell never makes it, so an unmounted drive cannot fill the disk underneath.';
	}
	if (!stat.isDirectory()) return 'That is a file, not a folder.';
	if (
		!(await fs.access(resolved, fsConstants.W_OK | fsConstants.X_OK).then(
			() => true,
			() => false
		))
	) {
		return 'MineShell cannot write there. Give the user it runs as write access to the folder.';
	}
	return null;
}

/** Whether `dir` is on the same file system as the servers: copies there survive a mistake, not a broken disk. */
export async function sameDiskAsServers(dir: string): Promise<boolean> {
	const [a, b] = await Promise.all([fs.stat(dir).catch(() => null), fs.stat(INSTANCES_DIR).catch(() => null)]);
	return !!a && !!b && a.dev === b.dev;
}

export async function addDestination(input: { name: string; path: string }): Promise<BackupDestination> {
	const dir = input.path.trim().replace(/(.)\/+$/, '$1');
	const problem = await folderProblem(dir);
	if (problem) throw new InstanceError(problem);
	const resolved = path.resolve(dir);
	const existing = listDestinations();
	if (existing.some((d) => d.path === resolved)) throw new InstanceError('That folder is already a backup folder.');
	const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 60) || path.basename(resolved);
	const destination: BackupDestination = { id: crypto.randomUUID().slice(0, 8), name, kind: 'folder', path: resolved };
	writeJson(DESTINATIONS_KEY, [...existing, destination]);
	audit('backups.destination_added', { detail: `${name}: ${resolved}` });
	return destination;
}

/** Removes a destination; servers copying there stop. The copies already there stay. */
export function removeDestination(id: string): void {
	const destination = getDestination(id);
	if (!destination) throw new InstanceError('That backup folder is no longer in the list.');
	writeJson(
		DESTINATIONS_KEY,
		listDestinations().filter((d) => d.id !== id)
	);
	for (const instance of listInstances()) {
		const setting = getServerBackup(instance.id);
		if (setting.destination === id) saveServerBackup(instance.id, { ...setting, destination: null });
	}
	audit('backups.destination_removed', { detail: `${destination.name}: ${destination.path}` });
}

function validServerBackup(raw: unknown): ServerBackup {
	const value = (raw ?? {}) as Record<string, unknown>;
	const keep = value.keep;
	return {
		destination: typeof value.destination === 'string' ? value.destination : null,
		copy: BACKUP_COPY_CHOICES.some((c) => c.value === value.copy) ? (value.copy as BackupCopy) : DEFAULT_SERVER_BACKUP.copy,
		keep: typeof keep === 'number' && Number.isInteger(keep) && keep >= KEEP_LIMITS[0] && keep <= KEEP_LIMITS[1] ? keep : DEFAULT_SERVER_BACKUP.keep
	};
}

export function getServerBackup(instanceId: string): ServerBackup {
	return validServerBackup(readJson(serverKey(instanceId)));
}

export function saveServerBackup(instanceId: string, backup: ServerBackup): void {
	writeJson(serverKey(instanceId), validServerBackup(backup));
}

export function deleteServerBackup(instanceId: string): void {
	db.delete(settings).where(eq(settings.key, serverKey(instanceId))).run();
	db.delete(settings).where(eq(settings.key, resultKey(instanceId))).run();
}

export function lastBackupResult(instanceId: string): BackupResult | null {
	const raw = readJson(resultKey(instanceId)) as BackupResult | null;
	return raw && typeof raw.at === 'number' && typeof raw.ok === 'boolean' && typeof raw.message === 'string' ? raw : null;
}

// --------------------------------------------------------------- store ---

/** Server ids are slugs (instances.ts slugify); a folder named otherwise on a destination is not one of them. */
export function isServerFolderName(name: string): boolean {
	return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

/** What a destination does. Each kind of destination is one of these. */
export type BackupStore = {
	/** Why it cannot be used now (not mounted, not writable), or null. */
	problem(): Promise<string | null>;
	/** Free bytes there; null when it cannot say. */
	freeBytes(): Promise<number | null>;
	/** The servers with copies there (folder names, the servers' ids). */
	servers(): Promise<string[]>;
	/** The finished copies of one server's snapshots, newest first. */
	list(serverId: string): Promise<Snapshot[]>;
	/** Copies a finished local snapshot folder there. */
	write(serverId: string, snapshotDir: string, snapshotId: string): Promise<void>;
	/** Copies one back into `into`, which must not exist yet. */
	read(serverId: string, snapshotId: string, into: string): Promise<void>;
	remove(serverId: string, snapshotId: string): Promise<void>;
	/** Rewrites a copy's manifest (pinned, name and tags follow the server's own). */
	writeManifest(serverId: string, snapshot: Snapshot): Promise<void>;
};

const PARTIAL = '.partial';
const COPY = { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true } as const;

export function folderStore(root: string): BackupStore {
	const serverDir = (serverId: string) => {
		if (!isServerFolderName(serverId)) throw new Error(`"${serverId}" is not a server's folder name.`);
		return path.join(root, serverId);
	};
	const copyDir = (serverId: string, snapshotId: string) => {
		if (!isSnapshotId(snapshotId)) throw new Error('No such snapshot.');
		return path.join(serverDir(serverId), snapshotId);
	};
	return {
		problem: () => folderProblem(root, { added: true }),
		freeBytes: () => freeSpace(root),
		async servers() {
			const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
			return entries.filter((e) => e.isDirectory() && isServerFolderName(e.name)).map((e) => e.name).sort();
		},
		async list(serverId) {
			const dir = serverDir(serverId);
			const found: Snapshot[] = [];
			for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
				if (!isSnapshotId(name)) continue;
				try {
					const manifest = JSON.parse(await fs.readFile(path.join(dir, name, MANIFEST), 'utf8')) as Snapshot;
					found.push({ ...manifest, id: name });
				} catch {
					/* not a finished copy */
				}
			}
			return found.sort((a, b) => b.createdAt - a.createdAt);
		},
		async write(serverId, snapshotDir, snapshotId) {
			const target = copyDir(serverId, snapshotId);
			const partial = target + PARTIAL;
			// Inside the destination, which exists: only the server's own folder is ever made.
			await fs.mkdir(serverDir(serverId), { recursive: false }).catch((err: NodeJS.ErrnoException) => {
				if (err.code !== 'EEXIST') throw err;
			});
			await fs.rm(partial, { recursive: true, force: true });
			try {
				await fs.cp(snapshotDir, partial, COPY);
				await fs.rename(partial, target);
			} catch (err) {
				await fs.rm(partial, { recursive: true, force: true }).catch(() => undefined);
				throw err;
			}
		},
		async read(serverId, snapshotId, into) {
			await fs.cp(copyDir(serverId, snapshotId), into, COPY);
		},
		async remove(serverId, snapshotId) {
			await fs.rm(copyDir(serverId, snapshotId), { recursive: true, force: true });
		},
		async writeManifest(serverId, snapshot) {
			const file = path.join(copyDir(serverId, snapshot.id), MANIFEST);
			const { id: _id, ...manifest } = snapshot;
			await fs.writeFile(`${file}.tmp`, JSON.stringify(manifest, null, 2), 'utf8');
			await fs.rename(`${file}.tmp`, file);
		}
	};
}

export function storeFor(destination: BackupDestination): BackupStore {
	return folderStore(destination.path);
}

// ---------------------------------------------------------------- plan ---

/** Whether a server's snapshot is one its setting copies: full ones only (a partial one is one dimension before a change). */
export function wantsCopy(snapshot: Snapshot, copy: BackupCopy): boolean {
	if (snapshot.partial) return false;
	return copy === 'all' || snapshot.reason === 'scheduled' || snapshot.reason === 'manual';
}

export type BackupPlan = {
	/** Local snapshots to copy there, newest first. */
	copy: Snapshot[];
	/** Copies there to delete. */
	remove: string[];
	/** Copies whose manifest is behind the local one (pinned, name, tags). */
	manifests: Snapshot[];
};

const details = (s: Snapshot) => JSON.stringify([!!s.pinned, s.note ?? null, s.tags ?? []]);

/**
 * What a sync does: the newest `keep` of what is there and what should be,
 * plus every pinned one, are kept there; whichever of those is missing there
 * is copied, and the rest there deleted. Pinned is the server's own say while
 * it still has the snapshot, the copy's own after that. A snapshot older than
 * the newest `keep` there is never copied only to be deleted.
 */
export function planBackup(local: Snapshot[], remote: Snapshot[], setting: Pick<ServerBackup, 'copy' | 'keep'>): BackupPlan {
	const localById = new Map(local.map((s) => [s.id, s]));
	const pinned = (s: Snapshot) => !!(localById.get(s.id) ?? s).pinned;
	const there = new Set(remote.map((s) => s.id));
	const wanted = local.filter((s) => wantsCopy(s, setting.copy) && !there.has(s.id));
	const kept = new Set<string>();
	let count = 0;
	for (const s of [...remote, ...wanted].sort((a, b) => b.createdAt - a.createdAt)) {
		if (pinned(s)) kept.add(s.id);
		else if (count < setting.keep) {
			kept.add(s.id);
			count++;
		}
	}
	return {
		copy: wanted.filter((s) => kept.has(s.id)).sort((a, b) => b.createdAt - a.createdAt),
		remove: remote.filter((s) => !kept.has(s.id)).map((s) => s.id),
		manifests: remote.flatMap((s) => {
			const own = localById.get(s.id);
			return kept.has(s.id) && own && details(own) !== details(s) ? [{ ...s, pinned: own.pinned, note: own.note, tags: own.tags }] : [];
		})
	};
}

// ---------------------------------------------------------------- sync ---

/** Room left on the destination after a copy, besides the copy itself. */
const SPARE_BYTES = 256 * 1024 * 1024;

/** One sync at a time, all servers together: copies are disk-bound, two at once only slow both. */
let queue: Promise<unknown> = Promise.resolve();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function record(instance: ServerInstance, destination: BackupDestination, ok: boolean, message: string): void {
	const before = lastBackupResult(instance.id);
	writeJson(resultKey(instance.id), { at: Date.now(), ok, message, destination: destination.id } satisfies BackupResult);
	// Once per run of failures: a drive left unplugged is one message, not one an hour.
	if (!ok && before?.ok !== false) {
		void notify({
			kind: 'backup',
			instance: { id: instance.id, name: instance.name },
			title: 'Backup copy failed',
			message: `Snapshots are not being copied to ${destination.name} (${destination.path}): ${message}`,
			at: Date.now()
		});
	}
	if (!ok) audit('backups.copy_failed', { instanceId: instance.id, detail: message, actor: 'backups' });
}

/**
 * Brings a server's backup folder in line with its snapshots (planBackup).
 * Copying runs as a task; a sync with nothing to do makes none. Resolves when
 * done; failures are recorded (and notified), not thrown.
 */
export function syncServer(instanceId: string): Promise<void> {
	const run = queue.then(() => syncNow(instanceId)).catch((err) => console.warn('[mineshell] backup sync failed:', err));
	queue = run;
	return run;
}

async function syncNow(instanceId: string): Promise<void> {
	const instance = getInstance(instanceId);
	if (!instance) return;
	const setting = getServerBackup(instance.id);
	if (!setting.destination) return;
	const destination = getDestination(setting.destination);
	if (!destination) return;
	const store = storeFor(destination);
	const problem = await store.problem();
	if (problem) return record(instance, destination, false, problem);
	let plan: BackupPlan;
	try {
		plan = planBackup(await listSnapshots(instance.path), await store.list(instance.id), setting);
	} catch (err) {
		return record(instance, destination, false, err instanceof Error ? err.message : 'its contents could not be read');
	}
	if (!plan.copy.length && !plan.remove.length && !plan.manifests.length) {
		if (lastBackupResult(instance.id)?.ok === false) record(instance, destination, true, 'Up to date.');
		return;
	}
	const label = plan.copy.length ? `Copying snapshots of ${instance.name} to ${destination.name}` : `Tidying ${destination.name} for ${instance.name}`;
	await new Promise<void>((resolve) => {
		startTask({ label, instanceId: instance.id }, async (task) => {
			try {
				const copied = await applyPlan(instance, store, plan, task);
				record(instance, destination, true, copied ? `Copied ${copied} snapshot${copied === 1 ? '' : 's'}.` : 'Up to date.');
				task.setProgress(100, 'Done');
			} catch (err) {
				record(instance, destination, false, err instanceof Error ? err.message : 'the copy failed');
				throw err;
			} finally {
				resolve();
			}
		});
	});
}

async function applyPlan(instance: ServerInstance, store: BackupStore, plan: BackupPlan, task: TaskHandle): Promise<number> {
	let copied = 0;
	for (const [i, snapshot] of plan.copy.entries()) {
		const source = snapshotPath(instance.path, snapshot.id);
		// Deleted or moved back by a world change since the plan: nothing to copy.
		if (!(await fs.stat(source).catch(() => null))) continue;
		const free = await store.freeBytes();
		if (free !== null && free - snapshot.sizeBytes < SPARE_BYTES) {
			throw new Error(`the backup folder is full: ${formatBytes(free)} free, and the snapshot is ${formatBytes(snapshot.sizeBytes)}.`);
		}
		task.setProgress(Math.round((i / plan.copy.length) * 100), `Copying ${snapshot.id} (${formatBytes(snapshot.sizeBytes)})`);
		await store.write(instance.id, source, snapshot.id);
		task.log(`Copied ${snapshot.id} (${formatBytes(snapshot.sizeBytes)}).`);
		copied++;
	}
	for (const snapshot of plan.manifests) await store.writeManifest(instance.id, snapshot);
	if (plan.remove.length) {
		task.setProgress(null, 'Deleting older copies');
		for (const id of plan.remove) await store.remove(instance.id, id);
		task.log(`Deleted older cop${plan.remove.length === 1 ? 'y' : 'ies'} there: ${plan.remove.join(', ')}.`);
	}
	return copied;
}

/**
 * A sync soon: after `delayMs`, and later still while the server has an
 * operation under way (a world change finishes its snapshot before it commits,
 * and a rollback would move it back).
 */
export function requestSync(instanceId: string, delayMs = 15_000): void {
	clearTimeout(pending.get(instanceId));
	pending.set(
		instanceId,
		setTimeout(() => {
			pending.delete(instanceId);
			if (listOperations().some((o) => o.instanceId === instanceId)) return requestSync(instanceId, 60_000);
			void syncServer(instanceId);
		}, delayMs)
	);
}

const RETRY_MS = 60 * 60_000;
const globals = globalThis as { __mineshellBackups?: boolean };

/** Started once (boot.ts): copies after every snapshot, a catch-up after start, retries of failed ones every hour. */
export function startBackups(): void {
	if (globals.__mineshellBackups) return;
	globals.__mineshellBackups = true;
	bus.subscribe('snapshot:finished', ({ instanceId }) => {
		if (getServerBackup(instanceId).destination) requestSync(instanceId);
	});
	setTimeout(() => {
		for (const instance of listInstances()) if (getServerBackup(instance.id).destination) requestSync(instance.id, 0);
	}, 2 * 60_000).unref();
	setInterval(() => {
		for (const instance of listInstances()) {
			if (getServerBackup(instance.id).destination && lastBackupResult(instance.id)?.ok === false) requestSync(instance.id, 0);
		}
	}, RETRY_MS).unref();
}

// ---------------------------------------------------------- the pages ---

export type BackupCopyView = Snapshot & { onServer: boolean };

/**
 * A server's copies on its destination for the World tab: null when it has
 * none set; `problem` when the folder cannot be read now.
 */
export async function backupView(instance: ServerInstance, fromServer = instance.id) {
	const setting = getServerBackup(instance.id);
	const destination = getDestination(setting.destination);
	if (!destination) return null;
	const store = storeFor(destination);
	const problem = await store.problem();
	const local = new Set((await listSnapshots(instance.path)).map((s) => s.id));
	const copies = problem ? [] : await store.list(fromServer).catch(() => []);
	return {
		destination: { id: destination.id, name: destination.name, path: destination.path },
		setting,
		problem,
		last: lastBackupResult(instance.id),
		fromServer,
		servers: problem ? [] : await store.servers(),
		copies: copies.map((c): BackupCopyView => ({ ...c, onServer: local.has(c.id) }))
	};
}

/**
 * Copies a snapshot back from the server's backup folder into its own
 * snapshots, from where it restores as any other (or becomes a new world).
 * `fromServer` names another server's folder there: the copies of a server
 * that is gone, brought into one made again.
 */
export async function copyBack(instance: ServerInstance, snapshotId: string, fromServer = instance.id): Promise<string> {
	const destination = getDestination(getServerBackup(instance.id).destination);
	if (!destination) throw new InstanceError('This server has no backup folder set.');
	if (!isSnapshotId(snapshotId) || !isServerFolderName(fromServer)) throw new InstanceError('No such copy.');
	const store = storeFor(destination);
	const problem = await store.problem();
	if (problem) throw new InstanceError(`${destination.name}: ${problem}`);
	const copy = (await store.list(fromServer)).find((s) => s.id === snapshotId);
	if (!copy) throw new InstanceError('That copy is no longer there.');
	if ((await listSnapshots(instance.path)).some((s) => s.id === snapshotId)) throw new InstanceError('The server has that snapshot already.');
	const free = await freeSpace(instance.path);
	const keepFree = getSnapshotPolicy(instance.id).minFreeMb * 1024 * 1024;
	if (free !== null && free - copy.sizeBytes < keepFree) {
		throw new InstanceError(`Only ${formatBytes(free)} is free on the server's disk; this copy (${formatBytes(copy.sizeBytes)}) would leave less than the ${formatBytes(keepFree)} to keep free.`);
	}
	audit('backups.copy_back', { instanceId: instance.id, detail: fromServer === instance.id ? snapshotId : `${fromServer}/${snapshotId}` });
	return startTask({ label: `Copying a snapshot back from ${destination.name}`, instanceId: instance.id }, async (task) => {
		const partial = partialPath(instance.path, snapshotId);
		await fs.mkdir(path.dirname(partial), { recursive: true });
		await fs.rm(partial, { recursive: true, force: true });
		task.setProgress(null, `Copying ${snapshotId} (${formatBytes(copy.sizeBytes)})`);
		try {
			await store.read(fromServer, snapshotId, partial);
			await fs.rename(partial, snapshotPath(instance.path, snapshotId));
		} catch (err) {
			await fs.rm(partial, { recursive: true, force: true }).catch(() => undefined);
			throw err;
		}
		task.log(`Copied ${snapshotId} back; it is under Snapshots, to restore or to make a world of.`);
		task.setProgress(100, 'Done');
	});
}
