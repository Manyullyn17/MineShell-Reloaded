import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings, type ServerInstance } from './db/schema';
import { directorySize } from './files';
import { serverWorldName } from './packworld';
import { formatBytes } from '$lib/shared/format';

/**
 * Copies of a server's world taken before MineShell does something that can
 * damage it: a pack version change (or reinstall), a loader version change,
 * a Cleanroom migration or revert, and the world tools (reset, replace,
 * restore). Not general backups - the server is always stopped, so the copy
 * is consistent without save-off/save-on.
 *
 * Each snapshot is a folder in `.mineshell/snapshots/` holding the world
 * folder(s) at their usual relative paths plus a manifest. It is written as
 * `<id>.partial` and renamed when complete, so a copy cut short by MineShell
 * stopping is never mistaken for a snapshot; recovery deletes the partial
 * ones. The copy is a step inside the operation's journal, before anything
 * moves.
 */

export const SNAPSHOTS_DIR = path.join('.mineshell', 'snapshots');
const PARTIAL = '.partial';
const MANIFEST = 'manifest.json';

export type SnapshotReason =
	| 'pack-change'
	| 'loader-change'
	| 'cleanroom-migration'
	| 'cleanroom-revert'
	| 'world-reset'
	| 'world-replace'
	| 'world-restore'
	| 'world-reset-dimension'
	| 'world-restore-dimension'
	| 'world-prune'
	| 'mod-update'
	| 'manual';

export type Snapshot = {
	id: string;
	createdAt: number;
	reason: SnapshotReason;
	/** What was about to happen, e.g. "Before changing the pack to 1.4.2". */
	label: string;
	/** World folders in the snapshot, relative to the server folder. */
	worlds: string[];
	/**
	 * Holds only these folders (one dimension, before it was reset), not the
	 * whole world: restoring it puts back just them.
	 */
	partial?: boolean;
	sizeBytes: number;
	/** What the world was last run on, to warn before restoring it onto something else. */
	minecraftVersion: string;
	modloader: string;
	modloaderVersion: string | null;
	packVersionName: string | null;
	/** Kept until unpinned: never deleted to make room, and not counted towards the limit. */
	pinned?: boolean;
};

// ---------------------------------------------------------------- policy ---

export type SnapshotPolicy = {
	/** Snapshots kept per server; older ones go once a new one is complete. */
	keep: number;
	/**
	 * Worlds above this size (MB) ask first whether to snapshot. -1 turns the
	 * question off: the snapshot is then always taken, never skipped.
	 */
	askAboveMb: number;
};

const POLICY_KEY = 'snapshots.policy';
export const DEFAULT_POLICY: SnapshotPolicy = { keep: 3, askAboveMb: 2048 };

function validPolicy(raw: unknown): SnapshotPolicy {
	const value = (raw ?? {}) as Partial<SnapshotPolicy>;
	const keep = Number.isInteger(value.keep) && value.keep! >= 1 && value.keep! <= 50 ? value.keep! : DEFAULT_POLICY.keep;
	const ask =
		Number.isInteger(value.askAboveMb) && value.askAboveMb! >= -1 ? value.askAboveMb! : DEFAULT_POLICY.askAboveMb;
	return { keep, askAboveMb: ask };
}

/** Every read is validated, so a stale or hand-edited row degrades to the defaults. */
export function getSnapshotPolicy(): SnapshotPolicy {
	const row = db.select().from(settings).where(eq(settings.key, POLICY_KEY)).get();
	try {
		return validPolicy(row ? JSON.parse(row.value) : null);
	} catch {
		return DEFAULT_POLICY;
	}
}

export function saveSnapshotPolicy(policy: SnapshotPolicy): SnapshotPolicy {
	const valid = validPolicy(policy);
	db.insert(settings)
		.values({ key: POLICY_KEY, value: JSON.stringify(valid) })
		.onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(valid) } })
		.run();
	return valid;
}

// ---------------------------------------------------------------- worlds ---

async function exists(p: string): Promise<boolean> {
	return fs.access(p).then(
		() => true,
		() => false
	);
}

/**
 * The server's world folders that exist, relative to its folder: what
 * `level-name` says, plus the separate dimension folders Bukkit-style
 * servers keep next to it.
 */
export async function worldFolders(root: string): Promise<string[]> {
	const name = await serverWorldName(root);
	const found: string[] = [];
	for (const candidate of [name, `${name}_nether`, `${name}_the_end`]) {
		if (await exists(path.join(root, candidate))) found.push(candidate);
	}
	return found;
}

export async function worldSize(root: string): Promise<number> {
	let total = 0;
	for (const world of await worldFolders(root)) total += await directorySize(path.join(root, world));
	return total;
}

/**
 * What an operation's form shows: whether this world is big enough to ask
 * about, and how big it is.
 */
export type SnapshotPrompt = { worldBytes: number; ask: boolean; policy: SnapshotPolicy };

export async function snapshotPrompt(root: string): Promise<SnapshotPrompt> {
	const policy = getSnapshotPolicy();
	const worldBytes = await worldSize(root);
	const ask = policy.askAboveMb !== -1 && worldBytes > policy.askAboveMb * 1024 * 1024;
	return { worldBytes, ask, policy };
}

export class SnapshotChoiceNeeded extends Error {}

/**
 * Whether to snapshot, from what the form sent (`snapshot` = yes | no).
 * Below the threshold, or with the question turned off, it always does and
 * the form's value is ignored; above it the form must say.
 */
export async function decideSnapshot(root: string, choice: FormDataEntryValue | null): Promise<boolean> {
	const prompt = await snapshotPrompt(root);
	if (prompt.worldBytes === 0) return false;
	if (!prompt.ask) return true;
	if (choice === 'yes') return true;
	if (choice === 'no') return false;
	throw new SnapshotChoiceNeeded(
		`The world is ${formatBytes(prompt.worldBytes)}. Choose whether to snapshot it first.`
	);
}

// ------------------------------------------------------------- snapshots ---

export function snapshotsDir(root: string): string {
	return path.join(root, SNAPSHOTS_DIR);
}

function stamp(at: number): string {
	const d = new Date(at);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** A fresh snapshot id; ids sort by time. */
export async function newSnapshotId(root: string, reason: SnapshotReason, at = Date.now()): Promise<string> {
	const base = `${stamp(at)}-${reason}`;
	let id = base;
	for (let n = 2; (await exists(path.join(snapshotsDir(root), id))) || (await exists(path.join(snapshotsDir(root), id + PARTIAL))); n++) {
		id = `${base}-${n}`;
	}
	return id;
}

/** Snapshot ids are generated here; anything else is refused before it reaches a path. */
export function isSnapshotId(id: string): boolean {
	return /^\d{4}-\d{2}-\d{2}_\d{6}-[a-z-]+(-\d+)?$/.test(id);
}

export async function listSnapshots(root: string): Promise<Snapshot[]> {
	const dir = snapshotsDir(root);
	const found: Snapshot[] = [];
	for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
		if (!isSnapshotId(name)) continue;
		try {
			const manifest = JSON.parse(await fs.readFile(path.join(dir, name, MANIFEST), 'utf8')) as Snapshot;
			found.push({ ...manifest, id: name });
		} catch {
			/* not a finished snapshot */
		}
	}
	return found.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getSnapshot(root: string, id: string): Promise<Snapshot | null> {
	if (!isSnapshotId(id)) return null;
	return (await listSnapshots(root)).find((s) => s.id === id) ?? null;
}

export type SnapshotInput = { reason: SnapshotReason; label: string };

function manifestFor(
	instance: ServerInstance,
	id: string,
	input: SnapshotInput,
	worlds: string[],
	sizeBytes: number,
	partial: boolean
): Snapshot {
	return {
		id,
		createdAt: Date.now(),
		reason: input.reason,
		label: input.label,
		worlds,
		...(partial ? { partial: true } : {}),
		sizeBytes,
		minecraftVersion: instance.minecraftVersion,
		modloader: instance.modloader,
		modloaderVersion: instance.modloaderVersion,
		packVersionName: instance.packVersionName
	};
}

/** Where a snapshot is assembled before it counts as one. */
export function partialPath(root: string, id: string): string {
	return path.join(snapshotsDir(root), id + PARTIAL);
}

export function snapshotPath(root: string, id: string): string {
	return path.join(snapshotsDir(root), id);
}

/**
 * Writes the manifest into a fully assembled `<id>.partial` and renames it,
 * which is the moment it becomes a snapshot.
 */
export async function finishSnapshot(
	instance: ServerInstance,
	id: string,
	input: SnapshotInput,
	worlds: string[],
	opts: { partial?: boolean } = {}
): Promise<Snapshot> {
	const partial = partialPath(instance.path, id);
	const manifest = manifestFor(instance, id, input, worlds, await directorySize(partial), opts.partial ?? false);
	await fs.writeFile(path.join(partial, MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
	await fs.rename(partial, snapshotPath(instance.path, id));
	return manifest;
}

/**
 * Copies the world into a new snapshot; null when there is no world yet.
 * Reflinks where the filesystem supports them (btrfs, XFS), so the copy is
 * instant there and costs no space until the world changes.
 */
export async function takeSnapshot(instance: ServerInstance, input: SnapshotInput): Promise<Snapshot | null> {
	const root = instance.path;
	const worlds = await worldFolders(root);
	if (!worlds.length) return null;
	const id = await newSnapshotId(root, input.reason);
	const partial = partialPath(root, id);
	try {
		for (const world of worlds) {
			await fs.mkdir(path.dirname(path.join(partial, world)), { recursive: true });
			await fs.cp(path.join(root, world), path.join(partial, world), {
				recursive: true,
				errorOnExist: true,
				force: false,
				preserveTimestamps: true,
				mode: fsConstants.COPYFILE_FICLONE
			});
		}
		return await finishSnapshot(instance, id, input, worlds);
	} catch (err) {
		await fs.rm(partial, { recursive: true, force: true });
		throw err;
	}
}

/** Keeps the newest `keep` unpinned snapshots, deleting older unpinned ones. Pinned ones always stay. */
export async function pruneSnapshots(root: string, keep: number): Promise<string[]> {
	const removed: string[] = [];
	for (const old of (await listSnapshots(root)).filter((s) => !s.pinned).slice(keep)) {
		await fs.rm(snapshotPath(root, old.id), { recursive: true, force: true });
		removed.push(old.id);
	}
	return removed;
}

export async function setSnapshotPinned(root: string, id: string, pinned: boolean): Promise<void> {
	const snapshot = await getSnapshot(root, id);
	if (!snapshot) throw new Error('That snapshot no longer exists.');
	const file = path.join(snapshotPath(root, id), MANIFEST);
	const { id: _id, ...manifest } = snapshot;
	await fs.writeFile(`${file}.tmp`, JSON.stringify({ ...manifest, pinned }, null, 2), 'utf8');
	await fs.rename(`${file}.tmp`, file);
}

export async function deleteSnapshot(root: string, id: string): Promise<void> {
	if (!isSnapshotId(id)) throw new Error('No such snapshot.');
	await fs.rm(snapshotPath(root, id), { recursive: true, force: true });
}

/** Copies that never finished (MineShell stopped mid-copy). */
export async function removePartialSnapshots(root: string): Promise<boolean> {
	let removed = false;
	for (const name of await fs.readdir(snapshotsDir(root)).catch(() => [] as string[])) {
		if (name.endsWith(PARTIAL)) {
			await fs.rm(path.join(snapshotsDir(root), name), { recursive: true, force: true });
			removed = true;
		}
	}
	return removed;
}

/** Logger the operations hand in (a task), so the step shows up in their log. */
type StepLog = { setProgress: (pct: number | null, label?: string) => void; log: (line: string) => void };

/**
 * The snapshot step of a risky operation: copy, then prune to the policy.
 * A failure throws, which fails (and rolls back) the operation before it
 * changed anything.
 */
export async function snapshotStep(instance: ServerInstance, input: SnapshotInput, task: StepLog): Promise<Snapshot | null> {
	task.setProgress(null, 'Snapshotting the world');
	const snapshot = await takeSnapshot(instance, input);
	if (!snapshot) {
		task.log('No world yet; nothing to snapshot.');
		return null;
	}
	task.log(`Snapshotted ${snapshot.worlds.join(', ')} (${formatBytes(snapshot.sizeBytes)}) as ${snapshot.id}.`);
	const removed = await pruneSnapshots(instance.path, getSnapshotPolicy().keep);
	if (removed.length) task.log(`Deleted older snapshot${removed.length === 1 ? '' : 's'}: ${removed.join(', ')}.`);
	return snapshot;
}
