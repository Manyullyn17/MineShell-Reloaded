import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings, type ServerInstance } from './db/schema';
import { directorySize } from './files';
import { serverWorldName } from './packworld';
import { formatBytes } from '#lib/shared/format.js';

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
	| 'manual'
	| 'scheduled';

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

/**
 * How many snapshots a server keeps. Full snapshots (the whole world) and
 * partial ones (one dimension, before a reset, restore or prune) are counted
 * apart, so a run of dimension resets never pushes the last full worlds out.
 * The newest `keepMin` / `partialMin` always stay; older ones stay, newest
 * first, while all kept snapshots together fit in `budgetMb` and the type is
 * under its max. Pinned snapshots are outside all of it. Sizes are file sizes:
 * on btrfs/XFS a snapshot shares space with the world, so it really takes less.
 */
export type SnapshotPolicy = {
	keepMin: number;
	keepMax: number;
	partialMin: number;
	partialMax: number;
	/** Storage for everything kept beyond the minimums, MB; full and partial share it. */
	budgetMb: number;
	/**
	 * Worlds above this size (MB) ask first whether to snapshot. -1 turns the
	 * question off: the snapshot is then always taken, never skipped.
	 */
	askAboveMb: number;
	/**
	 * A snapshot that copies the world is not taken when it would leave less
	 * than this much free on the disk (MB); 0 turns the check off. A full disk
	 * mid-save is how worlds get damaged.
	 */
	minFreeMb: number;
};

export const POLICY_FIELDS = ['keepMin', 'keepMax', 'partialMin', 'partialMax', 'budgetMb', 'askAboveMb', 'minFreeMb'] as const;

const POLICY_KEY = 'snapshots.policy';
const serverPolicyKey = (instanceId: string) => `snapshots.policy:${instanceId}`;
export const DEFAULT_POLICY: SnapshotPolicy = {
	keepMin: 3,
	keepMax: 50,
	partialMin: 5,
	partialMax: 100,
	budgetMb: 10 * 1024,
	askAboveMb: 2048,
	minFreeMb: 5 * 1024
};

const LIMITS: Record<keyof SnapshotPolicy, [number, number]> = {
	keepMin: [1, 500],
	keepMax: [1, 500],
	partialMin: [0, 500],
	partialMax: [0, 500],
	budgetMb: [0, 100 * 1024 * 1024],
	askAboveMb: [-1, 100 * 1024 * 1024],
	minFreeMb: [0, 100 * 1024 * 1024]
};

/** The fields of `raw` that are valid whole numbers in range; anything else is left out. */
function validFields(raw: unknown): Partial<SnapshotPolicy> {
	const value = (raw ?? {}) as Record<string, unknown>;
	const fields: Partial<SnapshotPolicy> = {};
	// Before October 2026 there was one number, `keep`: it becomes the minimum.
	if (value.keepMin === undefined && value.keep !== undefined) value.keepMin = value.keep;
	for (const field of POLICY_FIELDS) {
		const n = value[field];
		const [lo, hi] = LIMITS[field];
		if (typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi) fields[field] = n;
	}
	return fields;
}

/** A whole policy: defaults under the fields given, and a max never below its min. */
function complete(...layers: Partial<SnapshotPolicy>[]): SnapshotPolicy {
	const policy = Object.assign({}, DEFAULT_POLICY, ...layers) as SnapshotPolicy;
	policy.keepMax = Math.max(policy.keepMax, policy.keepMin);
	policy.partialMax = Math.max(policy.partialMax, policy.partialMin);
	return policy;
}

function readFields(key: string): Partial<SnapshotPolicy> {
	const row = db.select().from(settings).where(eq(settings.key, key)).get();
	try {
		return row ? validFields(JSON.parse(row.value)) : {};
	} catch {
		return {};
	}
}

function writeFields(key: string, fields: Partial<SnapshotPolicy>): void {
	const value = JSON.stringify(fields);
	db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

/**
 * The policy in force: the global one, with a server's own overrides on top
 * when an instance id is given. Every read is validated, so a stale or
 * hand-edited row degrades to the defaults field by field.
 */
export function getSnapshotPolicy(instanceId?: string): SnapshotPolicy {
	return complete(readFields(POLICY_KEY), instanceId ? readFields(serverPolicyKey(instanceId)) : {});
}

export function saveSnapshotPolicy(policy: Partial<SnapshotPolicy>): SnapshotPolicy {
	const fields = validFields(policy);
	writeFields(POLICY_KEY, fields);
	return complete(fields);
}

/** A server's own overrides only (what its settings page shows as set). */
export function serverSnapshotOverrides(instanceId: string): Partial<SnapshotPolicy> {
	return readFields(serverPolicyKey(instanceId));
}

/** Replaces a server's overrides; fields left out follow the global policy. */
export function saveServerSnapshotOverrides(instanceId: string, overrides: Partial<SnapshotPolicy>): void {
	const fields = validFields(overrides);
	if (Object.keys(fields).length) writeFields(serverPolicyKey(instanceId), fields);
	else deleteServerSnapshotOverrides(instanceId);
}

export function deleteServerSnapshotOverrides(instanceId: string): void {
	db.delete(settings).where(eq(settings.key, serverPolicyKey(instanceId))).run();
}

export function copyServerSnapshotOverrides(fromId: string, toId: string): void {
	const fields = serverSnapshotOverrides(fromId);
	if (Object.keys(fields).length) writeFields(serverPolicyKey(toId), fields);
}

const FIELD_LABELS: Record<keyof SnapshotPolicy, string> = {
	keepMin: 'Full snapshots always kept',
	keepMax: 'Full snapshots at most',
	partialMin: 'Partial snapshots always kept',
	partialMax: 'Partial snapshots at most',
	budgetMb: 'Storage for more',
	askAboveMb: 'Ask first above',
	minFreeMb: 'Keep free on the disk'
};

/**
 * The policy fields a settings form sent. Budget and free space come in GB
 * (budgetGb, minFreeGb), the rest as is. A blank field is left out: the
 * default globally, the global value for a server.
 */
export function policyFromForm(form: FormData): { fields: Partial<SnapshotPolicy>; error: string | null } {
	const fields: Partial<SnapshotPolicy> = {};
	for (const field of POLICY_FIELDS) {
		const gb = field === 'budgetMb' || field === 'minFreeMb';
		const raw = String(form.get(gb ? field.replace('Mb', 'Gb') : field) ?? '').trim();
		if (!raw) continue;
		const n = Number(raw);
		const value = gb ? Math.round(n * 1024) : n;
		const [lo, hi] = LIMITS[field];
		if (!Number.isFinite(n) || !Number.isInteger(value) || value < lo || value > hi) {
			return { fields, error: `${FIELD_LABELS[field]}: ${gb ? 'a number of GB' : 'a whole number'} from ${gb ? lo / 1024 : lo}${field === 'askAboveMb' ? ' (-1: never ask)' : ''}.` };
		}
		fields[field] = value;
	}
	if (fields.keepMin !== undefined && fields.keepMax !== undefined && fields.keepMax < fields.keepMin) {
		return { fields, error: 'Full snapshots at most cannot be fewer than always kept.' };
	}
	if (fields.partialMin !== undefined && fields.partialMax !== undefined && fields.partialMax < fields.partialMin) {
		return { fields, error: 'Partial snapshots at most cannot be fewer than always kept.' };
	}
	return { fields, error: null };
}

/** The snapshots the policy lets go: oldest first within what does not fit. Pinned ones never. */
export function snapshotsToDelete(snapshots: Snapshot[], policy: SnapshotPolicy): Snapshot[] {
	const unpinned = snapshots.filter((s) => !s.pinned).sort((a, b) => b.createdAt - a.createdAt);
	const kept = new Set<string>();
	const count = { full: 0, partial: 0 };
	let used = 0;
	const keep = (s: Snapshot) => {
		kept.add(s.id);
		count[s.partial ? 'partial' : 'full']++;
		used += s.sizeBytes;
	};
	for (const s of unpinned) {
		if (s.partial ? count.partial < policy.partialMin : count.full < policy.keepMin) keep(s);
	}
	const budget = policy.budgetMb * 1024 * 1024;
	for (const s of unpinned) {
		if (kept.has(s.id)) continue;
		const underMax = s.partial ? count.partial < policy.partialMax : count.full < policy.keepMax;
		if (underMax && used + s.sizeBytes <= budget) keep(s);
	}
	return unpinned.filter((s) => !kept.has(s.id)).reverse();
}

export type SnapshotUsage = { full: number; partial: number; pinned: number; bytes: number; pinnedBytes: number };

export async function snapshotUsage(root: string): Promise<SnapshotUsage> {
	const usage: SnapshotUsage = { full: 0, partial: 0, pinned: 0, bytes: 0, pinnedBytes: 0 };
	for (const s of await listSnapshots(root)) {
		usage.bytes += s.sizeBytes;
		if (s.pinned) {
			usage.pinned++;
			usage.pinnedBytes += s.sizeBytes;
		} else usage[s.partial ? 'partial' : 'full']++;
	}
	return usage;
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
export type SnapshotPrompt = {
	worldBytes: number;
	/** The form shows the question: the world is above askAboveMb, or a copy would not fit. */
	ask: boolean;
	/** Above askAboveMb alone; what counts for operations that move the world instead of copying it. */
	asksBySize: boolean;
	policy: SnapshotPolicy;
	/** Free on the disk holding the server, bytes; null when unknown. */
	freeBytes: number | null;
	/** A snapshot copying the world would leave less than minFreeMb free. */
	lowSpace: boolean;
};

/** Free bytes for an unprivileged user on the disk holding `dir`; null when the system cannot say. */
export async function freeSpace(dir: string): Promise<number | null> {
	try {
		const stats = await fs.statfs(dir);
		return stats.bavail * stats.bsize;
	} catch {
		return null;
	}
}

function lacksSpace(policy: SnapshotPolicy, worldBytes: number, freeBytes: number | null): boolean {
	return policy.minFreeMb > 0 && freeBytes !== null && worldBytes > 0 && freeBytes - worldBytes < policy.minFreeMb * 1024 * 1024;
}

export async function snapshotPrompt(instance: Pick<ServerInstance, 'id' | 'path'>): Promise<SnapshotPrompt> {
	const policy = getSnapshotPolicy(instance.id);
	const worldBytes = await worldSize(instance.path);
	const freeBytes = await freeSpace(instance.path);
	const lowSpace = lacksSpace(policy, worldBytes, freeBytes);
	const asksBySize = policy.askAboveMb !== -1 && worldBytes > policy.askAboveMb * 1024 * 1024;
	return { worldBytes, ask: lowSpace || asksBySize, asksBySize, policy, freeBytes, lowSpace };
}

export class SnapshotChoiceNeeded extends Error {}

/** A copying snapshot refused for lack of disk space (minFreeMb). */
export class LowDiskSpaceError extends Error {}

const lowSpaceMessage = (worldBytes: number, freeBytes: number, policy: SnapshotPolicy) =>
	`Only ${formatBytes(freeBytes)} is free on the disk; a snapshot of this world (${formatBytes(worldBytes)}) would leave less than the ${formatBytes(policy.minFreeMb * 1024 * 1024)} to keep free. Continue without a snapshot, or free some space first.`;

/**
 * Whether to snapshot, from what the form sent (`snapshot` = yes | no).
 * Below the threshold, or with the question turned off, it always does and
 * the form's value is ignored; above it the form must say. A snapshot that
 * would copy the world onto a nearly full disk is refused: only "no" goes
 * on. `moves`: the operation keeps the old world by moving it (the World
 * tab's reset, replace, restore, prune), which takes no space, so the disk
 * check does not apply.
 */
export async function decideSnapshot(
	instance: Pick<ServerInstance, 'id' | 'path'>,
	choice: FormDataEntryValue | null,
	opts: { moves?: boolean } = {}
): Promise<boolean> {
	const prompt = await snapshotPrompt(instance);
	if (prompt.worldBytes === 0) return false;
	if (prompt.lowSpace && !opts.moves) {
		if (choice === 'no') return false;
		throw new SnapshotChoiceNeeded(lowSpaceMessage(prompt.worldBytes, prompt.freeBytes ?? 0, prompt.policy));
	}
	if (!prompt.asksBySize) return true;
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
	// The form already asked; this catches what changed since, and callers that never ask (Snapshot now).
	const policy = getSnapshotPolicy(instance.id);
	const worldBytes = await worldSize(root);
	const freeBytes = await freeSpace(root);
	if (lacksSpace(policy, worldBytes, freeBytes)) throw new LowDiskSpaceError(lowSpaceMessage(worldBytes, freeBytes ?? 0, policy));
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

/** Deletes what the policy does not keep (snapshotsToDelete). Pinned ones always stay. */
export async function pruneSnapshots(root: string, policy: SnapshotPolicy): Promise<string[]> {
	const removed: string[] = [];
	for (const old of snapshotsToDelete(await listSnapshots(root), policy)) {
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
	const removed = await pruneSnapshots(instance.path, getSnapshotPolicy(instance.id));
	if (removed.length) task.log(`Deleted older snapshot${removed.length === 1 ? '' : 's'}: ${removed.join(', ')}.`);
	return snapshot;
}
