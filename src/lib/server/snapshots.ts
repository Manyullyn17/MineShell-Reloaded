import fs from 'node:fs/promises';
import { constants as fsConstants, createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings, type ServerInstance } from './db/schema';
import { CACHE_DIR } from './config';
import { bus } from './events';
import { directorySize } from './files';
import { serverWorldName } from './packworld';
import { formatBytes } from '#lib/shared/format.js';

/**
 * Copies of a server's world taken before MineShell does something that can
 * damage it: a pack version change (or reinstall), a loader version change,
 * a Cleanroom migration or revert, and the world tools (reset, replace,
 * restore), and the ones taken by hand or on a schedule. Those before an
 * operation are of a stopped server; one taken while it runs pauses its
 * saving for the copy (snapshotschedule.ts).
 *
 * Each snapshot is a folder in `.mineshell/snapshots/` holding the world
 * folder(s) at their usual relative paths plus a manifest. It is written as
 * `<id>.partial` and renamed when complete, so a copy cut short by MineShell
 * stopping is never mistaken for a snapshot; recovery deletes the partial
 * ones. The copy is a step inside the operation's journal, before anything
 * moves.
 *
 * A copied snapshot shares the files that did not change with the snapshots
 * before it, as hard links (`copyWorld`), so ten snapshots of a big world cost
 * it once plus what changed. That is safe because a snapshot's files are never
 * written to (manifests are replaced by rename, the Files tab replaces files
 * too) and the live world never shares a file with a snapshot (restoring
 * copies); deleting a snapshot, however, frees only what no other one still
 * names. Sizes on disk count each shared file once (`snapshotFiles`).
 */

export const SNAPSHOTS_DIR = path.join('.mineshell', 'snapshots');
const PARTIAL = '.partial';
export const MANIFEST = 'manifest.json';

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
	| 'world-restore-chunks'
	| 'world-prune'
	| 'mod-update'
	| 'migrate'
	| 'manual'
	| 'scheduled'
	| 'forge-confirm';

export type Snapshot = {
	id: string;
	createdAt: number;
	reason: SnapshotReason;
	/** What was about to happen, e.g. "Before changing the pack to 1.4.2". */
	label: string;
	/** World folders in the snapshot, relative to the server folder. */
	worlds: string[];
	/** The world (`level-name`) it was taken of; manifests from before 0.17.3 leave it out. */
	world?: string;
	/**
	 * Holds only these folders (one dimension, before it was reset), not the
	 * whole world: restoring it puts back just them.
	 */
	partial?: boolean;
	/**
	 * Partial ones: files the change after it created, where there were none
	 * (a chunk restore's region file for chunks the world did not have).
	 * Restoring it removes them, so it undoes the change whole.
	 */
	created?: string[];
	sizeBytes: number;
	/** What the world was last run on, to warn before restoring it onto something else. */
	minecraftVersion: string;
	modloader: string;
	modloaderVersion: string | null;
	packVersionName: string | null;
	/** Kept until unpinned: never deleted to make room, and not counted towards the limit. */
	pinned?: boolean;
	/** The user's own name for it, shown above `label`. */
	note?: string;
	/** The user's own tags, to find snapshots by. */
	tags?: string[];
};

export const NOTE_MAX = 120;
export const TAG_MAX = 32;
export const TAGS_MAX = 10;

/**
 * A note and tags as the user typed them (tags comma-separated), tidied:
 * trimmed, empty ones dropped, tags deduplicated ignoring case. Throws on
 * what cannot be stored.
 */
export function snapshotDetails(note: string, tags: string): { note: string | null; tags: string[] } {
	const cleanNote = note.replace(/\s+/g, ' ').trim();
	if (cleanNote.length > NOTE_MAX) throw new Error(`A name is at most ${NOTE_MAX} characters.`);
	const seen = new Set<string>();
	const cleanTags: string[] = [];
	for (const raw of tags.split(',')) {
		const tag = raw.replace(/\s+/g, ' ').trim();
		if (!tag || seen.has(tag.toLowerCase())) continue;
		if (tag.length > TAG_MAX) throw new Error(`A tag is at most ${TAG_MAX} characters ("${tag.slice(0, TAG_MAX)}...").`);
		seen.add(tag.toLowerCase());
		cleanTags.push(tag);
	}
	if (cleanTags.length > TAGS_MAX) throw new Error(`At most ${TAGS_MAX} tags.`);
	return { note: cleanNote || null, tags: cleanTags };
}

// ---------------------------------------------------------------- policy ---

/**
 * How many snapshots a server keeps. Full snapshots (the whole world) and
 * partial ones (one dimension, before a reset, restore or prune) are counted
 * apart, so a run of dimension resets never pushes the last full worlds out.
 * The newest `keepMin` / `partialMin` always stay; older ones stay, newest
 * first, while all kept snapshots together fit in `budgetMb` and the type is
 * under its max. Pinned snapshots are outside all of it. Sizes are what a
 * snapshot adds on disk: files it shares with ones already kept (hard links)
 * count once. On btrfs/XFS a copied file also shares space with the world
 * (reflinks), which no size here sees.
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
 * The policy fields a settings form sent. Sizes come in GB (budgetGb,
 * askAboveGb, minFreeGb), the rest as is; askAboveGb "never" is -1, minFreeGb
 * "off" is 0. A blank field is left out: the default globally, the global
 * value for a server.
 */
export function policyFromForm(form: FormData): { fields: Partial<SnapshotPolicy>; error: string | null } {
	const fields: Partial<SnapshotPolicy> = {};
	for (const field of POLICY_FIELDS) {
		const gb = field === 'budgetMb' || field === 'askAboveMb' || field === 'minFreeMb';
		const raw = String(form.get(gb ? field.replace('Mb', 'Gb') : field) ?? '').trim();
		if (!raw) continue;
		if (field === 'askAboveMb' && raw === 'never') {
			fields[field] = -1;
			continue;
		}
		if (field === 'minFreeMb' && raw === 'off') {
			fields[field] = 0;
			continue;
		}
		const n = Number(raw);
		const value = gb ? Math.round(n * 1024) : n;
		// -1 (never ask) comes as "never", not as a number.
		const [lo, hi] = [Math.max(LIMITS[field][0], 0), LIMITS[field][1]];
		if (!Number.isFinite(n) || !Number.isInteger(value) || value < lo || value > hi) {
			return { fields, error: `${FIELD_LABELS[field]}: ${gb ? 'a number of GB' : 'a whole number'} from ${gb ? lo / 1024 : lo}.` };
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

/**
 * The snapshots the policy lets go: oldest first within what does not fit.
 * Pinned ones never. With `files` (snapshotFiles), a snapshot costs only the
 * files not already in a kept or pinned one; without, its whole size.
 */
export function snapshotsToDelete(snapshots: Snapshot[], policy: SnapshotPolicy, files?: SnapshotFiles): Snapshot[] {
	const unpinned = snapshots.filter((s) => !s.pinned).sort((a, b) => b.createdAt - a.createdAt);
	const kept = new Set<string>();
	const count = { full: 0, partial: 0 };
	const seen = new Set<string>();
	for (const s of snapshots.filter((s) => s.pinned)) for (const key of files?.get(s.id)?.keys() ?? []) seen.add(key);
	const cost = (s: Snapshot) => {
		const own = files?.get(s.id);
		if (!own) return s.sizeBytes;
		let bytes = 0;
		for (const [key, size] of own) if (!seen.has(key)) bytes += size;
		return bytes;
	};
	let used = 0;
	const keep = (s: Snapshot, bytes: number) => {
		kept.add(s.id);
		count[s.partial ? 'partial' : 'full']++;
		used += bytes;
		for (const key of files?.get(s.id)?.keys() ?? []) seen.add(key);
	};
	for (const s of unpinned) {
		if (s.partial ? count.partial < policy.partialMin : count.full < policy.keepMin) keep(s, cost(s));
	}
	const budget = policy.budgetMb * 1024 * 1024;
	for (const s of unpinned) {
		if (kept.has(s.id)) continue;
		const underMax = s.partial ? count.partial < policy.partialMax : count.full < policy.keepMax;
		const bytes = cost(s);
		if (underMax && used + bytes <= budget) keep(s, bytes);
	}
	return unpinned.filter((s) => !kept.has(s.id)).reverse();
}

/** Each snapshot's files by inode ("device:inode") with their sizes: a file shared by hard links is one key. */
export type SnapshotFiles = Map<string, Map<string, number>>;

/**
 * Read once per snapshot folder, kept in memory and in MineShell's cache
 * folder, since a finished snapshot's files never change: walking every file
 * of 50 snapshots of a 5000-file world took 3 s, too long for the first page
 * after a restart. Keyed by the folder's own inode too, as a snapshot deleted
 * and copied back under its id is another folder.
 */
const filesCache = ((globalThis as { __mineshellSnapshotFiles?: Map<string, Map<string, number>> }).__mineshellSnapshotFiles ??= new Map());
const filesCacheDir = (root: string) => path.join(CACHE_DIR, 'snapshot-files', path.basename(root));

async function inodesUnder(dir: string, out: Map<string, number>): Promise<void> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	// Side by side: one at a time, the lookups waited on each other (3 s became 1.3).
	await Promise.all(
		entries.map(async (entry) => {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) return inodesUnder(full, out);
			const stat = await fs.lstat(full).catch(() => null);
			if (stat) out.set(`${stat.dev}:${stat.ino}`, stat.size);
		})
	);
}

export async function snapshotFiles(root: string, snapshots: Snapshot[]): Promise<SnapshotFiles> {
	const result: SnapshotFiles = new Map();
	const cacheDir = filesCacheDir(root);
	const current = new Set<string>();
	for (const s of snapshots) {
		const dir = await fs.stat(snapshotPath(root, s.id)).catch(() => null);
		if (!dir) continue;
		const name = `${s.id}@${dir.ino}.json`;
		current.add(name);
		const key = path.join(cacheDir, name);
		let files = filesCache.get(key);
		if (!files) {
			try {
				files = new Map(JSON.parse(await fs.readFile(key, 'utf8')) as [string, number][]);
			} catch {
				files = new Map();
				await inodesUnder(snapshotPath(root, s.id), files);
				await fs.mkdir(cacheDir, { recursive: true });
				await fs.writeFile(key, JSON.stringify([...files]), 'utf8').catch(() => undefined);
			}
			filesCache.set(key, files);
		}
		result.set(s.id, files);
	}
	// Lists of snapshots that are gone. Only with the whole list given, which is how every caller asks.
	if (snapshots.length === (await listSnapshots(root)).length) {
		for (const name of await fs.readdir(cacheDir).catch(() => [] as string[])) {
			if (!current.has(name)) {
				await fs.rm(path.join(cacheDir, name), { force: true });
				filesCache.delete(path.join(cacheDir, name));
			}
		}
	}
	return result;
}

/** A deleted server's cached file lists. */
export async function deleteSnapshotFilesCache(root: string): Promise<void> {
	await fs.rm(filesCacheDir(root), { recursive: true, force: true });
}

/**
 * What snapshots take on disk, each shared file once: in all, what each holds
 * alone (deleting it frees that), and what several share.
 */
export function diskBytes(files: SnapshotFiles, ids?: Iterable<string>): { total: number; own: Map<string, number>; shared: number } {
	const owners = new Map<string, { size: number; count: number; id: string }>();
	for (const id of ids ?? files.keys()) {
		for (const [key, size] of files.get(id) ?? []) {
			const o = owners.get(key);
			if (o) o.count++;
			else owners.set(key, { size, count: 1, id });
		}
	}
	const own = new Map<string, number>();
	let total = 0;
	let shared = 0;
	for (const o of owners.values()) {
		total += o.size;
		if (o.count > 1) shared += o.size;
		else own.set(o.id, (own.get(o.id) ?? 0) + o.size);
	}
	return { total, own, shared };
}

export type SnapshotUsage = { full: number; partial: number; pinned: number; bytes: number; pinnedBytes: number };

/** How many snapshots of each kind, and the bytes they take on disk (shared files once). */
export async function snapshotUsage(root: string): Promise<SnapshotUsage> {
	const usage: SnapshotUsage = { full: 0, partial: 0, pinned: 0, bytes: 0, pinnedBytes: 0 };
	const snapshots = await listSnapshots(root);
	for (const s of snapshots) {
		if (s.pinned) usage.pinned++;
		else usage[s.partial ? 'partial' : 'full']++;
	}
	const files = await snapshotFiles(root, snapshots);
	usage.bytes = diskBytes(files).total;
	usage.pinnedBytes = diskBytes(
		files,
		snapshots.filter((s) => s.pinned).map((s) => s.id)
	).total;
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

/**
 * Whether a snapshot is of the world `level` names, the only one it can be
 * restored onto: put back anywhere else, it lands beside the world the server
 * loads. Without `world` in the manifest, its folders tell: that world and its
 * Bukkit-style siblings, or folders inside them.
 */
export function snapshotOfWorld(snapshot: Pick<Snapshot, 'world' | 'worlds'>, level: string): boolean {
	if (snapshot.world !== undefined) return snapshot.world === level;
	const own = [level, `${level}_nether`, `${level}_the_end`];
	return snapshot.worlds.length > 0 && snapshot.worlds.every((p) => own.some((w) => p === w || p.startsWith(`${w}/`)));
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
	/** About what a snapshot would add on disk: files unchanged since the last one are shared (snapshotNeeds). */
	neededBytes: number;
	/** The form shows the question: the world is above askAboveMb, or a copy would not fit. */
	ask: boolean;
	/** Above askAboveMb alone; what counts for operations that move the world instead of copying it. */
	asksBySize: boolean;
	policy: SnapshotPolicy;
	/** Free on the disk holding the server, bytes; null when unknown. */
	freeBytes: number | null;
	/** A snapshot copying the world would leave less than minFreeMb free (by neededBytes). */
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

function lacksSpace(policy: SnapshotPolicy, neededBytes: number, freeBytes: number | null): boolean {
	return policy.minFreeMb > 0 && freeBytes !== null && neededBytes > 0 && freeBytes - neededBytes < policy.minFreeMb * 1024 * 1024;
}

/**
 * About what a snapshot copying the world now would add on disk: files whose
 * size and modification time match the newest snapshot's records (HASHES) are
 * most likely unchanged and would be links; the rest copies. The game sets the
 * time on every write, and region files often keep their size when they
 * change (it grows in 4 KB steps), so size alone would not do. The whole
 * world when no snapshot has records. Nothing is hashed: page loads ask this.
 */
export async function snapshotNeeds(root: string): Promise<number> {
	const worlds = await worldFolders(root);
	let records: Record<string, FileRecord> | null = null;
	for (const s of await listSnapshots(root)) {
		if ((records = await readHashes(snapshotPath(root, s.id)))) break;
	}
	let needed = 0;
	for (const world of worlds) {
		for (const entry of await fs.readdir(path.join(root, world), { withFileTypes: true, recursive: true }).catch(() => [])) {
			if (!entry.isFile()) continue;
			const full = path.join(entry.parentPath, entry.name);
			const stat = await fs.stat(full).catch(() => null);
			if (!stat) continue;
			const record = records?.[path.relative(root, full).split(path.sep).join('/')];
			// Times are kept to the millisecond (utimes), the live file's can be finer.
			if (!record || record[0] !== stat.size || Math.abs(record[1] - stat.mtimeMs) >= 1) needed += stat.size;
		}
	}
	return needed;
}

export async function snapshotPrompt(instance: Pick<ServerInstance, 'id' | 'path'>): Promise<SnapshotPrompt> {
	const policy = getSnapshotPolicy(instance.id);
	const worldBytes = await worldSize(instance.path);
	const freeBytes = await freeSpace(instance.path);
	const neededBytes = worldBytes ? await snapshotNeeds(instance.path) : 0;
	const lowSpace = lacksSpace(policy, neededBytes, freeBytes);
	const asksBySize = policy.askAboveMb !== -1 && worldBytes > policy.askAboveMb * 1024 * 1024;
	return { worldBytes, neededBytes, ask: lowSpace || asksBySize, asksBySize, policy, freeBytes, lowSpace };
}

export class SnapshotChoiceNeeded extends Error {}

/** A copying snapshot refused for lack of disk space (minFreeMb). */
export class LowDiskSpaceError extends Error {}

const lowSpaceMessage = (neededBytes: number, freeBytes: number, policy: SnapshotPolicy) =>
	`Only ${formatBytes(freeBytes)} is free on the disk; a snapshot of this world (about ${formatBytes(neededBytes)} that earlier snapshots do not share) would leave less than the ${formatBytes(policy.minFreeMb * 1024 * 1024)} to keep free. Continue without a snapshot, or free some space first.`;

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
		throw new SnapshotChoiceNeeded(lowSpaceMessage(prompt.neededBytes, prompt.freeBytes ?? 0, prompt.policy));
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

export type SnapshotInput = { reason: SnapshotReason; label: string; note?: string | null; tags?: string[] };

function manifestFor(
	instance: ServerInstance,
	id: string,
	input: SnapshotInput,
	worlds: string[],
	world: string,
	sizeBytes: number,
	partial: boolean,
	created: string[] = []
): Snapshot {
	return {
		id,
		createdAt: Date.now(),
		reason: input.reason,
		label: input.label,
		worlds,
		world,
		...(partial ? { partial: true } : {}),
		...(partial && created.length ? { created } : {}),
		sizeBytes,
		minecraftVersion: instance.minecraftVersion,
		modloader: instance.modloader,
		modloaderVersion: instance.modloaderVersion,
		packVersionName: instance.packVersionName,
		...(input.note ? { note: input.note } : {}),
		...(input.tags?.length ? { tags: input.tags } : {})
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
	opts: { partial?: boolean; created?: string[] } = {}
): Promise<Snapshot> {
	const partial = partialPath(instance.path, id);
	const world = await serverWorldName(instance.path);
	const manifest = manifestFor(instance, id, input, worlds, world, await directorySize(partial), opts.partial ?? false, opts.created);
	await fs.writeFile(path.join(partial, MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
	await fs.rename(partial, snapshotPath(instance.path, id));
	bus.publish('snapshot:finished', { instanceId: instance.id, snapshotId: id });
	return manifest;
}

// ----------------------------------------------------- shared files ---

/** Beside a copied snapshot's manifest: each world file's size, modification time and SHA-256. */
export const HASHES = 'hashes.json';
type FileRecord = [size: number, mtimeMs: number, sha256: string];

/** Files earlier snapshots hold, by size and then hash, newest snapshot first: what a new one can link to. */
type LinkIndex = Map<number, Map<string, { file: string; mtimeMs: number }>>;

export async function readHashes(dir: string): Promise<Record<string, FileRecord> | null> {
	try {
		const parsed = JSON.parse(await fs.readFile(path.join(dir, HASHES), 'utf8')) as { version?: number; files?: Record<string, FileRecord> };
		return parsed.version === 1 && parsed.files ? parsed.files : null;
	} catch {
		return null;
	}
}

async function linkIndex(root: string): Promise<LinkIndex> {
	const index: LinkIndex = new Map();
	for (const s of await listSnapshots(root)) {
		const dir = snapshotPath(root, s.id);
		for (const [rel, [size, mtimeMs, hash]] of Object.entries((await readHashes(dir)) ?? {})) {
			let bySize = index.get(size);
			if (!bySize) index.set(size, (bySize = new Map()));
			if (!bySize.has(hash)) bySize.set(hash, { file: path.join(dir, rel), mtimeMs });
		}
	}
	return index;
}

export async function hashFile(file: string): Promise<string> {
	const hash = crypto.createHash('sha256');
	await pipeline(createReadStream(file), hash);
	return hash.digest('hex');
}

/**
 * Copies world folders into `partial`, linking each file whose contents an
 * earlier snapshot holds to that snapshot's file instead of copying it. A live
 * file is hashed only when some snapshot has a file of its size (region files
 * mostly differ); a link is made only while the target still has the size
 * and time it was recorded with, so a file changed in place since is never
 * shared further. A copied file is hashed as copied, so a record always
 * matches what is stored. Returns the records for HASHES.
 */
async function copyWorld(root: string, worlds: string[], partial: string, index: LinkIndex): Promise<Record<string, FileRecord>> {
	const records: Record<string, FileRecord> = {};
	async function walk(rel: string): Promise<void> {
		const to = path.join(partial, rel);
		await fs.mkdir(to, { recursive: true });
		for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
			const childRel = path.posix.join(rel, entry.name);
			const from = path.join(root, childRel);
			const dest = path.join(partial, childRel);
			if (entry.isDirectory()) {
				await walk(childRel);
				continue;
			}
			const stat = await fs.lstat(from);
			if (stat.isSymbolicLink()) {
				await fs.symlink(await fs.readlink(from), dest);
				continue;
			}
			if (!stat.isFile()) continue;
			const candidates = index.get(stat.size);
			if (candidates) {
				const hash = await hashFile(from);
				const found = candidates.get(hash);
				const target = found && (await fs.stat(found.file).catch(() => null));
				if (found && target && target.size === stat.size && target.mtimeMs === found.mtimeMs) {
					const linked = await fs.link(found.file, dest).then(
						() => true,
						() => false
					);
					if (linked) {
						records[childRel] = [stat.size, found.mtimeMs, hash];
						continue;
					}
				}
			}
			await fs.copyFile(from, dest, fsConstants.COPYFILE_FICLONE);
			await fs.utimes(dest, stat.atime, stat.mtime);
			const copied = await fs.stat(dest);
			records[childRel] = [copied.size, copied.mtimeMs, await hashFile(dest)];
		}
	}
	for (const world of worlds) await walk(world);
	return records;
}

/**
 * Copies the world into a new snapshot; null when there is no world yet.
 * Files an earlier snapshot holds unchanged are hard links to it (copyWorld);
 * the rest are copied with reflinks where the filesystem has them (btrfs,
 * XFS), instant there and costing no space until the world changes.
 */
export async function takeSnapshot(instance: ServerInstance, input: SnapshotInput): Promise<Snapshot | null> {
	const root = instance.path;
	const worlds = await worldFolders(root);
	if (!worlds.length) return null;
	// The form already asked; this catches what changed since, and callers that never ask (Snapshot now).
	const policy = getSnapshotPolicy(instance.id);
	const neededBytes = await snapshotNeeds(root);
	const freeBytes = await freeSpace(root);
	if (lacksSpace(policy, neededBytes, freeBytes)) throw new LowDiskSpaceError(lowSpaceMessage(neededBytes, freeBytes ?? 0, policy));
	const id = await newSnapshotId(root, input.reason);
	const partial = partialPath(root, id);
	try {
		const hashes = await copyWorld(root, worlds, partial, await linkIndex(root));
		await fs.writeFile(path.join(partial, HASHES), JSON.stringify({ version: 1, files: hashes }), 'utf8');
		return await finishSnapshot(instance, id, input, worlds);
	} catch (err) {
		await fs.rm(partial, { recursive: true, force: true });
		throw err;
	}
}

/** Deletes what the policy does not keep (snapshotsToDelete). Pinned ones always stay. */
export async function pruneSnapshots(root: string, policy: SnapshotPolicy): Promise<string[]> {
	const removed: string[] = [];
	const snapshots = await listSnapshots(root);
	for (const old of snapshotsToDelete(snapshots, policy, await snapshotFiles(root, snapshots))) {
		await fs.rm(snapshotPath(root, old.id), { recursive: true, force: true });
		removed.push(old.id);
	}
	return removed;
}

/** Rewrites a finished snapshot's manifest with `change` applied; the folders are not touched. */
async function updateManifest(root: string, id: string, change: (manifest: Omit<Snapshot, 'id'>) => Omit<Snapshot, 'id'>): Promise<void> {
	const snapshot = await getSnapshot(root, id);
	if (!snapshot) throw new Error('That snapshot no longer exists.');
	const file = path.join(snapshotPath(root, id), MANIFEST);
	const { id: _id, ...manifest } = snapshot;
	await fs.writeFile(`${file}.tmp`, JSON.stringify(change(manifest), null, 2), 'utf8');
	await fs.rename(`${file}.tmp`, file);
}

export async function setSnapshotPinned(root: string, id: string, pinned: boolean): Promise<void> {
	await updateManifest(root, id, (manifest) => ({ ...manifest, pinned }));
}

/** Sets or clears the user's name and tags for a snapshot (`snapshotDetails` tidies them first). */
export async function setSnapshotDetails(root: string, id: string, details: { note: string | null; tags: string[] }): Promise<void> {
	await updateManifest(root, id, ({ note: _note, tags: _tags, ...manifest }) => ({
		...manifest,
		...(details.note ? { note: details.note } : {}),
		...(details.tags.length ? { tags: details.tags } : {})
	}));
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
