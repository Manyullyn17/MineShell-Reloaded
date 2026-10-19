import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import yazl from 'yazl';
import yauzl from 'yauzl';
import type { ServerInstance } from './db/schema';
import {
	audit,
	getInstance,
	InstanceError,
	rconPassword,
	requireStopped,
	setStatus,
	summarise
} from './instances';
import { beginOperation, commitOperation, endOperation, OperationInProgressError, type Journal } from './operations';
import { patchProperties, readProperties } from './properties';
import { rconExec } from './rcon';
import { startTask, type TaskHandle } from './tasks';
import { serverWorldName } from './packworld';
import { deleteToTrash } from './trash';
import { getMapSettings, isRenderingMap, keptMapDir, mapDir, saveMapSettings, webRoot } from './worldmap';
import {
	cleanWorldName,
	freeWorldFolder,
	listWorlds,
	newerWorldWarning,
	readWorldMeta,
	snapshotWorldFolder,
	WORLD_PROPERTY_KEYS,
	worldBytes,
	worldFolderNames,
	writeWorldMeta,
	type WorldMeta
} from './worlds';
import { formatBytes } from '#lib/shared/format.js';
import { findDimension, listDimensions, type Dimension } from './dimensions';
import { analyseRegions, applyPrune, planPrune } from './chunkprune';
import { NO_CHUNK, prunes, UNREADABLE, type AnalysedRegion, type PruneRule } from '#lib/shared/chunkprune.js';
import { assembleChunkRestore, planChunkRestore } from './chunkrestore';
import { child, parseNbt } from './nbt';
import { constants as fsConstants } from 'node:fs';
import {
	finishSnapshot,
	getSnapshot,
	getSnapshotPolicy,
	newSnapshotId,
	partialPath,
	deleteSnapshot,
	listSnapshots,
	pruneSnapshots,
	snapshotPath,
	snapshotOfWorld,
	snapshotPrompt,
	snapshotStep,
	worldFolders,
	type Snapshot,
	type SnapshotInput
} from './snapshots';

/**
 * The world tools: reset, replace with an uploaded zip, restore a snapshot,
 * snapshot on request, download as a zip.
 *
 * Reset, replace and restore share one journalled shape (`world-change`):
 * the current world folders are moved aside - straight into a new snapshot
 * when one is wanted, so keeping the old world costs no copy - then the new
 * world moves into place. A failure, in-process or across a restart, moves
 * the old folders back (`restoreWorldChange`).
 */

export type WorldChangeJournal = Extract<Journal, { kind: 'world-change' }>;

async function exists(p: string): Promise<boolean> {
	return fs.access(p).then(
		() => true,
		() => false
	);
}

function begin(instanceId: string, journal: Journal): void {
	try {
		beginOperation(instanceId, journal);
	} catch (err) {
		if (err instanceof OperationInProgressError) throw new InstanceError(err.message);
		throw err;
	}
}

/**
 * Puts the world back as it was before a world change, from its journal. What
 * moved is read from disk: a world folder still in the aside folder (or in
 * the finished snapshot it became) was moved; one that is not never left.
 */
export async function restoreWorldChange(root: string, journal: WorldChangeJournal): Promise<void> {
	const aside = path.join(root, journal.aside);
	const keepAs = journal.keepAs ? path.join(root, journal.keepAs) : null;
	const source = (await exists(aside)) ? aside : keepAs && (await exists(keepAs)) ? keepAs : null;
	for (const name of journal.placing) {
		if (!journal.worlds.includes(name)) await fs.rm(path.join(root, name), { recursive: true, force: true });
	}
	for (const name of journal.worlds) {
		if (!source || !(await exists(path.join(source, name)))) continue;
		await fs.rm(path.join(root, name), { recursive: true, force: true });
		await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
		await fs.rename(path.join(source, name), path.join(root, name));
	}
	if (journal.propertiesBefore) await patchProperties(root, journal.propertiesBefore);
	if (source) await fs.rm(source, { recursive: true, force: true });
	if (journal.incoming) await fs.rm(path.join(root, journal.incoming), { recursive: true, force: true });
}

type WorldChange = {
	action: WorldChangeJournal['action'];
	/**
	 * Folders to move aside, relative to the server folder; default: every
	 * world folder. One dimension's folders make the snapshot partial.
	 */
	moving?: string[];
	/** Shown in the task list and the snapshot, e.g. "Before resetting the world". */
	label: string;
	snapshot: boolean;
	/** World folders the change puts in place (from `incoming`). */
	placing: string[];
	/** Fills the incoming folder; omitted when nothing comes in (reset). */
	assemble?: (incoming: string, task: TaskHandle) => Promise<void>;
	/** server.properties values to set. */
	properties?: Record<string, string>;
	done: string;
	/** Runs once the task has ended, however it ended. */
	afterwards?: () => Promise<void>;
};

async function runWorldChange(instance: ServerInstance, change: WorldChange): Promise<string> {
	await requireStopped(instance);
	const root = instance.path;
	const worlds = change.moving
		? (await Promise.all(change.moving.map(async (p) => ((await exists(path.join(root, p))) ? p : null)))).filter(
				(p): p is string => p !== null
			)
		: await worldFolders(root);
	const now = Date.now();
	const snapshotId = change.snapshot && worlds.length ? await newSnapshotId(root, `world-${change.action}`) : null;
	const rel = (p: string) => path.relative(root, p);
	let propertiesBefore: Record<string, string> | null = null;
	if (change.properties) {
		const { values } = await readProperties(root);
		propertiesBefore = Object.fromEntries(Object.keys(change.properties).map((k) => [k, values[k] ?? '']));
	}
	const journal: WorldChangeJournal = {
		kind: 'world-change',
		action: change.action,
		aside: snapshotId ? rel(partialPath(root, snapshotId)) : path.join('.mineshell', `world-previous-${now}`),
		keepAs: snapshotId ? rel(snapshotPath(root, snapshotId)) : null,
		worlds,
		placing: change.placing,
		incoming: change.assemble ? path.join('.mineshell', `world-incoming-${now}`) : null,
		propertiesBefore
	};
	begin(instance.id, journal);
	setStatus(instance.id, 'provisioning', change.label);
	const taskId = startTask({ label: `${change.label}: ${instance.name}`, instanceId: instance.id }, (task) =>
		applyWorldChange(instance, change, journal, snapshotId, worlds, task).finally(() => change.afterwards?.())
	);
	return taskId;
}

async function applyWorldChange(
	instance: ServerInstance,
	change: WorldChange,
	journal: WorldChangeJournal,
	snapshotId: string | null,
	worlds: string[],
	task: TaskHandle
): Promise<void> {
	const root = instance.path;
	const aside = path.join(root, journal.aside);
	const incoming = journal.incoming ? path.join(root, journal.incoming) : null;
	try {
		// The slow part first, while nothing has moved.
		if (incoming && change.assemble) {
			await fs.mkdir(incoming, { recursive: true });
			await change.assemble(incoming, task);
		}
		const what = change.moving ? 'what is there now' : 'the current world';
		task.setProgress(null, snapshotId ? `Moving ${what} into a snapshot` : `Moving ${what} aside`);
		await fs.mkdir(aside, { recursive: true });
		for (const name of worlds) {
			await fs.mkdir(path.dirname(path.join(aside, name)), { recursive: true });
			await fs.rename(path.join(root, name), path.join(aside, name));
		}
		if (incoming) {
			task.setProgress(null, 'Putting the new world in place');
			for (const name of change.placing) {
				await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
				await fs.rename(path.join(incoming, name), path.join(root, name));
			}
		}
		if (change.properties) await patchProperties(root, change.properties);
		if (snapshotId) {
			const snapshot = await finishSnapshot(
				instance,
				snapshotId,
				{ reason: `world-${change.action}`, label: `Before ${change.label.toLowerCase()}` },
				worlds,
				{ partial: !!change.moving }
			);
			task.log(`${change.moving ? 'What was there' : 'The previous world'} is kept as snapshot ${snapshot.id}.`);
		}
		commitOperation(instance.id, {});
	} catch (err) {
		task.log('The change failed; putting the world back.');
		await restoreWorldChange(root, journal);
		endOperation(instance.id);
		setStatus(instance.id, 'ready', `${change.label} failed and the world was put back: ${err instanceof Error ? err.message : 'unknown error'}`);
		throw err;
	}

	// Committed: tidy up. A failure here leaves folders that recovery removes.
	if (!snapshotId) await fs.rm(aside, { recursive: true, force: true });
	if (incoming) await fs.rm(incoming, { recursive: true, force: true });
	const removed = await pruneSnapshots(root, getSnapshotPolicy(instance.id));
	if (removed.length) task.log(`Deleted older snapshot${removed.length === 1 ? '' : 's'}: ${removed.join(', ')}.`);
	setStatus(instance.id, 'ready', null);
	audit(`instance.world_${change.action}`, { instanceId: instance.id });
	task.log(change.done);
	task.setProgress(100, 'Ready');
}

export type SeedChoice = { mode: 'keep' } | { mode: 'random' } | { mode: 'set'; seed: string };

/** Delete the world so the next start generates a new one. */
export async function resetWorld(instance: ServerInstance, opts: { snapshot: boolean; seed: SeedChoice }): Promise<string> {
	// "Keep" with level-seed blank used to give the new world a new random seed: the world's
	// own seed is written down, so the reset world is the same terrain, regenerated.
	const kept = opts.seed.mode === 'keep' && !(await readProperties(instance.path)).values['level-seed'] ? await worldSeed(instance.path) : null;
	const properties =
		opts.seed.mode === 'random'
			? { 'level-seed': '' }
			: opts.seed.mode === 'set'
				? { 'level-seed': opts.seed.seed }
				: kept
					? { 'level-seed': kept }
					: undefined;
	return runWorldChange(instance, {
		action: 'reset',
		label: 'Resetting the world',
		snapshot: opts.snapshot,
		placing: [],
		properties,
		done: 'The world is gone; the next start generates a new one.'
	});
}

/**
 * Refuses a snapshot of another world than the active one: restored, it would
 * sit beside the world the server loads, and that world would be moved aside
 * for nothing.
 */
async function requireOfActiveWorld(root: string, snapshot: Snapshot): Promise<void> {
	const level = await serverWorldName(root);
	if (snapshotOfWorld(snapshot, level)) return;
	throw new InstanceError(
		`This snapshot is of another world (${snapshot.world ?? snapshot.worlds.join(', ')}) than the active one (${level}). Switch to that world under Worlds to restore it, or make a new world from it.`
	);
}

/** Put a snapshot's world back in place of the current one. */
export async function restoreSnapshot(instance: ServerInstance, id: string, opts: { snapshot: boolean }): Promise<string> {
	const snapshot = await getSnapshot(instance.path, id);
	if (!snapshot) throw new InstanceError('That snapshot no longer exists.');
	await requireOfActiveWorld(instance.path, snapshot);
	const from = snapshotPath(instance.path, snapshot.id);
	return runWorldChange(instance, {
		action: 'restore',
		label: snapshot.partial ? 'Restoring part of the world' : 'Restoring a world snapshot',
		snapshot: opts.snapshot,
		// A partial snapshot (one dimension) replaces just its folders.
		moving: snapshot.partial ? snapshot.worlds : undefined,
		placing: snapshot.worlds,
		// Copied, not moved: the snapshot stays usable.
		assemble: async (incoming, task) => {
			task.setProgress(null, `Copying snapshot ${snapshot.id}`);
			for (const name of snapshot.worlds) {
				await fs.mkdir(path.dirname(path.join(incoming, name)), { recursive: true });
				await fs.cp(path.join(from, name), path.join(incoming, name), { recursive: true, preserveTimestamps: true });
			}
		},
		done: `Restored the world from ${snapshot.id}.`
	});
}

/**
 * Delete one dimension so the next start generates it again. The overworld
 * means its terrain (region, entities, poi); level.dat, player data and the
 * world's data stay. Players standing in it come back at the same spot in the
 * new terrain.
 */
export async function resetDimension(instance: ServerInstance, key: string, opts: { snapshot: boolean }): Promise<string> {
	const dimension = await findDimension(instance.path, key);
	if (!dimension) throw new InstanceError('That dimension is not in the world.');
	return runWorldChange(instance, {
		action: 'reset-dimension',
		label: `Resetting ${dimension.label}`,
		snapshot: opts.snapshot,
		moving: dimension.paths,
		placing: [],
		done: `${dimension.label} is gone; the next start generates it again.`
	});
}

/** Put one dimension back from a snapshot, leaving the rest of the world as it is. */
export async function restoreDimension(
	instance: ServerInstance,
	snapshotId: string,
	key: string,
	opts: { snapshot: boolean }
): Promise<string> {
	const snapshot = await getSnapshot(instance.path, snapshotId);
	if (!snapshot) throw new InstanceError('That snapshot no longer exists.');
	await requireOfActiveWorld(instance.path, snapshot);
	const from = snapshotPath(instance.path, snapshot.id);
	const dimension = (await snapshotDimensions(instance, snapshot)).find((d) => d.paths[0] === key);
	if (!dimension) throw new InstanceError('That snapshot does not have this dimension.');
	return runWorldChange(instance, {
		action: 'restore-dimension',
		label: `Restoring ${dimension.label}`,
		snapshot: opts.snapshot,
		moving: dimension.paths,
		placing: dimension.paths,
		assemble: async (incoming, task) => {
			task.setProgress(null, `Copying ${dimension.label} from snapshot ${snapshot.id}`);
			for (const rel of dimension.paths) {
				await fs.mkdir(path.dirname(path.join(incoming, rel)), { recursive: true });
				await fs.cp(path.join(from, rel), path.join(incoming, rel), { recursive: true, preserveTimestamps: true });
			}
		},
		done: `Restored ${dimension.label} from ${snapshot.id}.`
	});
}

/** Most chunks one restore takes: 64 region files' worth. */
export const MAX_RESTORE_CHUNKS = 64 * 1024;

/**
 * Put chosen chunks of one dimension back from a snapshot (chunkrestore.ts),
 * leaving every other chunk as it is. Only the region files holding a chosen
 * chunk move aside - into a partial snapshot of just those files when wanted.
 */
export async function restoreChunks(
	instance: ServerInstance,
	snapshotId: string,
	key: string,
	chunks: [number, number][],
	opts: { snapshot: boolean }
): Promise<string> {
	if (!chunks.length) throw new InstanceError('Pick the chunks to restore first.');
	if (chunks.length > MAX_RESTORE_CHUNKS) throw new InstanceError(`That is more than ${MAX_RESTORE_CHUNKS} chunks; restore the whole dimension instead.`);
	if (!chunks.every((c) => c.length === 2 && c.every((n) => Number.isInteger(n) && Math.abs(n) < 2 ** 21))) throw new InstanceError('Those are not chunk positions.');
	await requireStopped(instance);
	const snapshot = await getSnapshot(instance.path, snapshotId);
	if (!snapshot) throw new InstanceError('That snapshot no longer exists.');
	await requireOfActiveWorld(instance.path, snapshot);
	const from = snapshotPath(instance.path, snapshot.id);
	const dimension = (await snapshotDimensions(instance, snapshot)).find((d) => d.paths[0] === key);
	if (!dimension) throw new InstanceError('That snapshot does not have this dimension.');
	const base = path.relative(instance.path, dimensionBase(instance.path, dimension));
	const plan = await planChunkRestore(instance.path, base, from, base, chunks);
	if (!plan.moving.length && !plan.placing.length) throw new InstanceError('Neither the world nor the snapshot has any of those chunks.');
	const count = `${chunks.length} chunk${chunks.length === 1 ? '' : 's'}`;
	return runWorldChange(instance, {
		action: 'restore-chunks',
		label: `Restoring ${count} of ${dimension.label}`,
		snapshot: opts.snapshot,
		moving: plan.moving,
		placing: plan.placing,
		assemble: async (incoming, task) => {
			task.setProgress(null, `Copying ${count} from snapshot ${snapshot.id}`);
			await assembleChunkRestore(instance.path, from, incoming, plan);
			task.log(
				`${plan.restored} chunk${plan.restored === 1 ? '' : 's'} come back from the snapshot${plan.removed ? `; ${plan.removed} it did not have yet go and generate again` : ''}.`
			);
		},
		done: `Restored ${count} of ${dimension.label} from ${snapshot.id}.`
	});
}

/**
 * Where the chunk map reads a dimension: the live world (`source` "live") or
 * a snapshot of the active world. Null when that has no such dimension.
 */
export async function chunkMapFolder(instance: ServerInstance, source: string, key: string): Promise<{ base: string; worldDir: string; dimension: Dimension } | null> {
	const level = await serverWorldName(instance.path);
	if (source === 'live') {
		const dimension = await findDimension(instance.path, key);
		return dimension ? { base: dimensionBase(instance.path, dimension), worldDir: path.join(instance.path, level), dimension } : null;
	}
	const snapshot = await getSnapshot(instance.path, source);
	if (!snapshot || !snapshotOfWorld(snapshot, level)) return null;
	const root = snapshotPath(instance.path, snapshot.id);
	const dimension = (await snapshotDimensions(instance, snapshot)).find((d) => d.paths[0] === key);
	if (!dimension) return null;
	// A partial snapshot has no level.dat: the live world's names the same block numbers.
	const own = path.join(root, level);
	const worldDir = (await exists(path.join(own, 'level.dat'))) ? own : path.join(instance.path, level);
	return { base: dimensionBase(root, dimension), worldDir, dimension };
}

/** The dimensions a snapshot holds, found the way the live world's are. */
export async function snapshotDimensions(instance: ServerInstance, snapshot: Snapshot): Promise<Dimension[]> {
	return listDimensions(snapshotPath(instance.path, snapshot.id), await serverWorldName(instance.path));
}

// ------------------------------------------------------------ chunk pruning ---

export type PruneSettings = {
	/** Chunks visited for fewer ticks than this go. */
	maxTicks: number;
	/** Overworld only: chunks within this many blocks of the world spawn stay. */
	keepAroundSpawn: number;
};

/** What an analysis read: every chunk's InhabitedTime, for the map that previews pruning. */
export type PruneAnalysis = {
	dimension: string;
	label: string;
	at: number;
	spawn: { x: number; z: number } | null;
	regions: AnalysedRegion[];
	chunks: number;
	unreadable: number;
};

/**
 * The last analysis per server, for the World tab. In memory: it is a
 * picture of a moment, quick to redo, and a few MB for a big world. On
 * globalThis, so a dev reload does not lose it.
 */
const analysisGlobals = globalThis as {
	__mineshellPruneAnalyses?: Map<string, PruneAnalysis>;
	__mineshellAnalysing?: Map<string, { taskId: string; dimension: string }>;
};
const pruneAnalyses = (analysisGlobals.__mineshellPruneAnalyses ??= new Map());
/** The analysis running per server, so the page shows its progress by the button, also when opened again. */
const analysing = (analysisGlobals.__mineshellAnalysing ??= new Map());

export function runningPruneAnalysis(instanceId: string): { taskId: string; dimension: string } | null {
	return analysing.get(instanceId) ?? null;
}

export function pruneAnalysis(instanceId: string): PruneAnalysis | null {
	return pruneAnalyses.get(instanceId) ?? null;
}

/** The analysis without its chunks, for the page's data. */
export function pruneAnalysisSummary(instanceId: string) {
	const found = pruneAnalyses.get(instanceId);
	if (!found) return null;
	const { regions, ...summary } = found;
	return { ...summary, regionCount: regions.length };
}

/**
 * The seed the world was generated with, from level.dat: Data.WorldGenSettings.seed
 * from 1.16, Data.RandomSeed before. Null without a world (or an unreadable one).
 * With level-seed blank in server.properties this is the random one picked at creation.
 */
export async function worldSeed(root: string): Promise<string | null> {
	try {
		const level = parseNbt(await fs.readFile(path.join(root, await serverWorldName(root), 'level.dat')));
		const data = child(level.root, 'Data');
		const seed = child(child(data, 'WorldGenSettings'), 'seed') ?? child(data, 'RandomSeed');
		return seed?.type === 'long' ? String(seed.value) : null;
	} catch {
		return null;
	}
}

/**
 * The world spawn from level.dat: Data.spawn.pos [x, y, z] from 1.21.9,
 * Data.SpawnX/SpawnZ before; null when unreadable.
 */
export async function worldSpawn(root: string): Promise<{ x: number; z: number } | null> {
	try {
		const level = parseNbt(await fs.readFile(path.join(root, await serverWorldName(root), 'level.dat')));
		const data = child(level.root, 'Data');
		const pos = child(child(data, 'spawn'), 'pos');
		if (pos?.type === 'intArray' && pos.value.length === 3) return { x: pos.value[0], z: pos.value[2] };
		const x = child(data, 'SpawnX');
		const z = child(data, 'SpawnZ');
		return x?.type === 'int' && z?.type === 'int' ? { x: x.value, z: z.value } : null;
	} catch {
		return null;
	}
}

/** The folder holding a dimension's region/: the world folder for the overworld, else the dimension's own. */
export function dimensionBase(root: string, dimension: Dimension): string {
	return path.join(root, dimension.overworld ? path.dirname(dimension.paths[0]) : dimension.paths[0]);
}

async function pruneOptions(root: string, dimension: Dimension, settings: PruneSettings): Promise<PruneRule> {
	const spawn = dimension.overworld && settings.keepAroundSpawn > 0 ? await worldSpawn(root) : null;
	return { maxTicks: settings.maxTicks, keep: spawn ? { ...spawn, radius: settings.keepAroundSpawn } : null };
}

function validSettings(settings: PruneSettings): PruneSettings {
	if (!Number.isInteger(settings.maxTicks) || settings.maxTicks < 1) throw new InstanceError('Pick how long a chunk must have been visited to stay.');
	if (!Number.isInteger(settings.keepAroundSpawn) || settings.keepAroundSpawn < 0) throw new InstanceError('The radius to keep is a whole number of blocks.');
	return settings;
}

/**
 * Reads every chunk's InhabitedTime in a dimension, without changing
 * anything, so the World tab can draw the heatmap and show what a threshold
 * would prune. Reads only, so it also runs while the server is up (it is then
 * a moment's picture; the prune checks every chunk again).
 */
export async function analysePrunable(instance: ServerInstance, key: string): Promise<string> {
	// Taken before anything is awaited, so two quick clicks cannot both start one.
	if (analysing.has(instance.id)) throw new InstanceError('An analysis of this server is already running.');
	const reserved = { taskId: '', dimension: key };
	analysing.set(instance.id, reserved);
	let dimension: Dimension | null;
	let spawn: { x: number; z: number } | null;
	try {
		dimension = await findDimension(instance.path, key);
		if (!dimension) throw new InstanceError('That dimension is not in the world.');
		spawn = dimension.overworld ? await worldSpawn(instance.path) : null;
	} catch (err) {
		analysing.delete(instance.id);
		throw err;
	}
	const found = dimension;
	const label = `Analysing ${found.label} for pruning: ${instance.name}`;
	const cancel = 'Stops the analysis; nothing in the world changes, and the last finished analysis stays.';
	const taskId = startTask({ label, instanceId: instance.id, cancel }, async (task) => {
		try {
			const regions = await analyseRegions(
				dimensionBase(instance.path, found),
				(done, total) => task.setProgress(total ? (done / total) * 100 : null, `Reading region file ${done} of ${total}`),
				task.isCancelled
			);
			if (!regions) {
				task.log('Cancelled.');
				return;
			}
			let chunks = 0;
			let unreadable = 0;
			for (const r of regions) {
				for (const t of r.ticks) {
					if (t === NO_CHUNK) continue;
					chunks++;
					if (t === UNREADABLE) unreadable++;
				}
			}
			pruneAnalyses.set(instance.id, { dimension: key, label: found.label, at: Date.now(), spawn, regions, chunks, unreadable });
			task.log(`Read ${chunks} chunks in ${regions.length} region files${unreadable ? `; ${unreadable} could not be read and stay` : ''}.`);
		} finally {
			analysing.delete(instance.id);
		}
	});
	reserved.taskId = taskId;
	return taskId;
}

/**
 * The chunks a prune may remove: the ones the analysis showed would go under
 * these settings, minus the protected ones. Anything generated or visited
 * since stays, whatever the threshold says.
 */
function analysedPrunable(analysis: PruneAnalysis, rule: PruneRule, protect: Set<string>) {
	const allowed = new Set<string>();
	let protectedCount = 0;
	for (const r of analysis.regions) {
		for (let i = 0; i < 1024; i++) {
			const t = r.ticks[i];
			if (t === NO_CHUNK || t === UNREADABLE) continue;
			const cx = r.x * 32 + (i % 32);
			const cz = r.z * 32 + Math.floor(i / 32);
			if (!prunes(t, cx, cz, rule)) continue;
			if (protect.has(`${cx},${cz}`)) protectedCount++;
			else allowed.add(`${cx},${cz}`);
		}
	}
	return { allowed, protectedCount };
}

/** Protected chunks as the form sends them: "x,z;x,z;...". */
export function parseChunkList(value: string): Set<string> {
	const out = new Set<string>();
	for (const part of value.split(';')) {
		if (!part) continue;
		const [x, z] = part.split(',').map(Number);
		if (!Number.isInteger(x) || !Number.isInteger(z)) throw new InstanceError('The protected chunks could not be read.');
		out.add(`${x},${z}`);
	}
	return out;
}

/**
 * Deletes barely visited chunks of one dimension. A world change like the
 * others: the dimension is copied (a reflink where the filesystem can), the
 * copy pruned, then the original moves aside - into a partial snapshot when
 * wanted - and the pruned copy takes its place. A failure or crash puts the
 * original back.
 */
export async function pruneChunks(
	instance: ServerInstance,
	key: string,
	settings: PruneSettings,
	opts: { snapshot: boolean; analysedAt: number; protect: Set<string> }
): Promise<string> {
	validSettings(settings);
	const dimension = await findDimension(instance.path, key);
	if (!dimension) throw new InstanceError('That dimension is not in the world.');
	const analysis = pruneAnalyses.get(instance.id);
	if (!analysis || analysis.dimension !== key || analysis.at !== opts.analysedAt) {
		throw new InstanceError(`Analyse ${dimension.label} again: the map this was picked on is no longer the latest.`);
	}
	const rule = await pruneOptions(instance.path, dimension, settings);
	const { allowed, protectedCount } = analysedPrunable(analysis, rule, opts.protect);
	if (!allowed.size) throw new InstanceError('No chunk would go: every one the threshold picks is protected.');
	return runWorldChange(instance, {
		action: 'prune',
		label: `Pruning ${dimension.label}`,
		snapshot: opts.snapshot,
		moving: dimension.paths,
		placing: dimension.paths,
		assemble: async (incoming, task) => {
			task.setProgress(null, `Copying ${dimension.label}`);
			for (const rel of dimension.paths) {
				await fs.mkdir(path.dirname(path.join(incoming, rel)), { recursive: true });
				await fs.cp(path.join(instance.path, rel), path.join(incoming, rel), {
					recursive: true,
					preserveTimestamps: true,
					mode: fsConstants.COPYFILE_FICLONE
				});
			}
			const base = dimensionBase(incoming, dimension);
			const plan = await planPrune(base, { ...rule, allow: (cx, cz) => allowed.has(`${cx},${cz}`) }, (done, total) =>
				task.setProgress(total ? (done / total) * 90 : null, `Reading region file ${done} of ${total}`)
			);
			task.setProgress(null, `Removing ${plan.remove} chunks`);
			await applyPrune(base, plan);
			// The world changed under it: the map is drawn again from a new analysis.
			if (pruneAnalyses.get(instance.id) === analysis) pruneAnalyses.delete(instance.id);
			const kept = allowed.size - plan.remove;
			task.log(
				`Removed ${plan.remove} of ${plan.chunks} chunks${protectedCount ? `; ${protectedCount} protected` : ''}${kept ? `; ${kept} picked on the map were visited or changed since and stayed` : ''}.`
			);
		},
		done: `${dimension.label} is pruned; removed chunks generate again when someone goes there.`
	});
}

/**
 * Take a snapshot now, outside any other operation. `then` runs in the same
 * task once the snapshot is finished (a start after answering Forge's
 * question); it does not run when the snapshot fails.
 */
export async function snapshotNow(
	instance: ServerInstance,
	opts: { input?: SnapshotInput; label?: string; then?: (task: TaskHandle) => Promise<void> } = {}
): Promise<string> {
	await requireStopped(instance);
	if (!(await worldFolders(instance.path)).length) throw new InstanceError('There is no world to snapshot yet.');
	const prompt = await snapshotPrompt(instance);
	if (prompt.lowSpace) {
		throw new InstanceError(
			`Only ${formatBytes(prompt.freeBytes ?? 0)} is free on the disk; this snapshot (${formatBytes(prompt.worldBytes)}) would leave less than the ${formatBytes(prompt.policy.minFreeMb * 1024 * 1024)} to keep free.`
		);
	}
	begin(instance.id, { kind: 'snapshot' });
	setStatus(instance.id, 'provisioning', 'Snapshotting the world');
	const taskId = startTask({ label: opts.label ?? `Snapshot ${instance.name}`, instanceId: instance.id }, async (task) => {
		try {
			await snapshotStep(instance, opts.input ?? { reason: 'manual', label: 'Taken by hand' }, task);
		} catch (err) {
			endOperation(instance.id);
			setStatus(instance.id, 'ready', `Snapshotting the world failed: ${err instanceof Error ? err.message : 'unknown error'}`);
			throw err;
		}
		commitOperation(instance.id, { status: 'ready', statusMessage: null });
		await opts.then?.(task);
		task.setProgress(100, 'Ready');
	});
	return taskId;
}

// ------------------------------------------------------------ worlds ---

export type WorldSwitchJournal = Extract<Journal, { kind: 'world-switch' }>;

/** Switching to a world that last ran on a newer Minecraft; the form asks, `force` goes ahead. */
export class WorldVersionError extends Error {}

const keptWeb = (instanceId: string, world: string) => path.join(keptMapDir(instanceId, world), 'web');

/**
 * Undoes a world switch from its journal: the map's web app back where it
 * was, `level-name` and the world's settings as before. What moved is read
 * from disk: the leaving map (kept or in `discard`) existing means it moved,
 * and then whatever is active now is the arriving world's.
 */
export async function restoreWorldSwitch(instanceId: string, root: string, journal: WorldSwitchJournal): Promise<void> {
	const web = webRoot(instanceId);
	const arriving = keptWeb(instanceId, journal.to);
	const putBack = async () => {
		await fs.mkdir(path.dirname(arriving), { recursive: true });
		await fs.rename(web, arriving);
	};
	if (journal.hadMap) {
		const aside = journal.discard ?? keptWeb(instanceId, journal.from);
		if (await exists(aside)) {
			if (await exists(web)) await putBack();
			await fs.rename(aside, web);
		}
	} else if (await exists(web)) {
		await putBack();
	}
	await patchProperties(root, journal.propertiesBefore);
}

/**
 * Makes `to` the active world: what the leaving world had is recorded for
 * when it comes back, the map's web app swaps with the arriving world's kept
 * one (the leaving one kept, or deleted without `keepMap`), and `level-name`
 * and the world's own settings are written. Journalled: nothing in the
 * server folder moves, so a failure only has the map and the properties to
 * put back.
 */
async function activateWorld(
	instance: ServerInstance,
	to: string,
	opts: { keepMap: boolean; properties: Record<string, string>; packDatapacks: string | null; arriving?: WorldMeta }
): Promise<void> {
	const root = instance.path;
	const from = await serverWorldName(root);
	const { values } = await readProperties(root);
	const setting = { 'level-name': to, ...opts.properties };
	const web = webRoot(instance.id);
	const hadMap = await exists(web);
	// A leftover from before would read as this switch's move.
	await fs.rm(keptWeb(instance.id, from), { recursive: true, force: true });
	// Measured now, while nothing writes to it: it does not change until it is active again.
	const leavingBytes = await worldBytes(root, from);
	const journal: WorldSwitchJournal = {
		kind: 'world-switch',
		from,
		to,
		propertiesBefore: Object.fromEntries(Object.keys(setting).map((k) => [k, values[k] ?? ''])),
		hadMap,
		discard: hadMap && !opts.keepMap ? path.join(mapDir(instance.id), `discard-${Date.now()}`) : null
	};
	begin(instance.id, journal);
	try {
		const meta = await readWorldMeta(root);
		const arriving = { ...meta.worlds[to], ...opts.arriving };
		const map = getMapSettings(instance.id);
		const { map: _map, ...leaving } = meta.worlds[from] ?? {};
		meta.worlds[from] = {
			...leaving,
			// Only those set: an empty level-type is not the default one to every version.
			properties: Object.fromEntries(WORLD_PROPERTY_KEYS.filter((k) => k in values).map((k) => [k, values[k]])),
			packDatapacks: instance.packDatapacks,
			...((await exists(path.join(root, from, 'level.dat')))
				? {
						lastRun: {
							minecraftVersion: instance.minecraftVersion,
							modloader: instance.modloader,
							modloaderVersion: instance.modloaderVersion,
							packVersionName: instance.packVersionName
						}
					}
				: {}),
			leftAt: Date.now(),
			sizeBytes: leavingBytes,
			...(hadMap && opts.keepMap ? { map: { lastRenderAt: map.lastRenderAt, sizeBytes: map.sizeBytes } } : {})
		};
		const { map: arrivingMap, sizeBytes: _size, ...arrivingRest } = arriving;
		meta.worlds[to] = arrivingRest;

		if (hadMap) {
			const aside = journal.discard ?? keptWeb(instance.id, from);
			await fs.mkdir(path.dirname(aside), { recursive: true });
			await fs.rename(web, aside);
		}
		if (await exists(keptWeb(instance.id, to))) await fs.rename(keptWeb(instance.id, to), web);
		await patchProperties(root, setting);
		await writeWorldMeta(root, meta);
		commitOperation(instance.id, { packDatapacks: opts.packDatapacks });
		saveMapSettings(instance.id, {
			lastRenderAt: arrivingMap?.lastRenderAt ?? null,
			sizeBytes: arrivingMap?.sizeBytes ?? null
		});
	} catch (err) {
		await restoreWorldSwitch(instance.id, root, journal);
		endOperation(instance.id);
		throw err;
	}
	if (journal.discard) await fs.rm(journal.discard, { recursive: true, force: true });
	await fs.rm(keptMapDir(instance.id, to), { recursive: true, force: true });
	// Only when empty: the other worlds' kept maps are in it.
	await fs.rmdir(path.dirname(keptMapDir(instance.id, to))).catch(() => undefined);
	audit('instance.world_switched', { instanceId: instance.id, detail: `${from} -> ${to}` });
}

async function requireSwitchable(instance: ServerInstance): Promise<void> {
	await requireStopped(instance);
	if (isRenderingMap(instance.id)) throw new InstanceError('The map is being updated; wait for it to finish first.');
}

/**
 * Makes another of the server's worlds the active one. A world that last ran
 * on a newer Minecraft is refused with WorldVersionError unless `force`.
 */
export async function switchWorld(instance: ServerInstance, folder: string, opts: { keepMap: boolean; force?: boolean }): Promise<void> {
	await requireSwitchable(instance);
	const world = (await listWorlds(instance)).find((w) => w.folder === folder);
	if (!world) throw new InstanceError('That world is not on this server.');
	if (world.active) throw new InstanceError(`${world.name} is already the active world.`);
	const warning = newerWorldWarning(instance, world);
	if (warning && !opts.force) throw new WorldVersionError(warning);
	const own = (await readWorldMeta(instance.path)).worlds[folder];
	await activateWorld(instance, folder, {
		keepMap: opts.keepMap,
		// One MineShell has never seen active: its seed is in its level.dat, not in level-seed.
		properties: own?.properties ?? { 'level-seed': '' },
		packDatapacks: own?.packDatapacks ?? null
	});
}

/**
 * Starts a new world beside the others and makes it active; the server
 * generates it on its next start. Level type and generator settings stay as
 * they are. `copyDatapacks` copies the current world's data packs into it
 * (world-generation ones apply from the first start), and with them which of
 * them came with the pack.
 */
export async function createWorld(
	instance: ServerInstance,
	opts: { name: string; seed: string | null; copyDatapacks: boolean; keepMap: boolean }
): Promise<string> {
	await requireSwitchable(instance);
	const root = instance.path;
	let name: string;
	try {
		name = cleanWorldName(opts.name);
	} catch (err) {
		throw new InstanceError((err as Error).message);
	}
	const folder = await freeWorldFolder(root, name);
	const datapacks = path.join(root, await serverWorldName(root), 'datapacks');
	const copying = opts.copyDatapacks && (await fs.readdir(datapacks).catch(() => [])).length > 0;
	if (copying) await fs.cp(datapacks, path.join(root, folder, 'datapacks'), { recursive: true, preserveTimestamps: true });
	try {
		await activateWorld(instance, folder, {
			keepMap: opts.keepMap,
			properties: { 'level-seed': opts.seed ?? '' },
			packDatapacks: copying ? instance.packDatapacks : null,
			arriving: { name, createdAt: Date.now() }
		});
	} catch (err) {
		await fs.rm(path.join(root, folder), { recursive: true, force: true });
		throw err;
	}
	return folder;
}

/** Gives a world another name; its folder stays (snapshots and maps know it by that). */
export async function renameWorld(instance: ServerInstance, folder: string, rawName: string): Promise<void> {
	let name: string;
	try {
		name = cleanWorldName(rawName);
	} catch (err) {
		throw new InstanceError((err as Error).message);
	}
	if (!(await worldFolderNames(instance.path)).includes(folder)) throw new InstanceError('That world is not on this server.');
	const meta = await readWorldMeta(instance.path);
	meta.worlds[folder] = { ...meta.worlds[folder], name };
	await writeWorldMeta(instance.path, meta);
}

/**
 * Deletes a world that is not active: its folders go to the trash (Files can
 * put them back for as long as the trash keeps them), its kept map is
 * deleted, and with `snapshots` its unpinned snapshots too. Returns how many
 * snapshots went.
 */
export async function deleteWorld(instance: ServerInstance, folder: string, opts: { snapshots: boolean }): Promise<number> {
	if (instance.status === 'provisioning') throw new InstanceError('Wait for the current operation to finish.');
	const root = instance.path;
	const worlds = await listWorlds(instance);
	const world = worlds.find((w) => w.folder === folder);
	if (!world) throw new InstanceError('That world is not on this server.');
	if (world.active) throw new InstanceError('This is the active world: switch to another one first.');
	for (const rel of world.folders) await deleteToTrash(root, rel);
	const meta = await readWorldMeta(root);
	delete meta.worlds[folder];
	await writeWorldMeta(root, meta);
	await fs.rm(keptMapDir(instance.id, folder), { recursive: true, force: true });
	let removed = 0;
	if (opts.snapshots) {
		const names = worlds.map((w) => w.folder);
		for (const s of await listSnapshots(root)) {
			if (s.pinned || snapshotWorldFolder(s, names) !== folder) continue;
			await deleteSnapshot(root, s.id);
			removed++;
		}
	}
	audit('instance.world_deleted', { instanceId: instance.id, detail: folder });
	return removed;
}

/**
 * Copies a full snapshot out as a new world beside the others, not active:
 * the way back to a deleted world, or a second copy of one. The server may
 * run meanwhile, as nothing it uses is touched. Assembled in a
 * `world-incoming-` folder, which recovery removes when cut short.
 */
export async function worldFromSnapshot(instance: ServerInstance, snapshotId: string, rawName: string): Promise<{ taskId: string; folder: string }> {
	const root = instance.path;
	const snapshot = await getSnapshot(root, snapshotId);
	if (!snapshot) throw new InstanceError('That snapshot no longer exists.');
	if (snapshot.partial) throw new InstanceError('That snapshot holds only part of a world.');
	let name: string;
	try {
		name = cleanWorldName(rawName);
	} catch (err) {
		throw new InstanceError((err as Error).message);
	}
	const source = snapshotWorldFolder(snapshot, await worldFolderNames(root));
	const target = (rel: string) => (rel === source || rel.startsWith(`${source}_`) ? rel.replace(source, '') : null);
	if (snapshot.worlds.some((rel) => target(rel) === null)) throw new InstanceError('MineShell cannot tell which world that snapshot holds.');
	const folder = await freeWorldFolder(root, name);
	const mapped = snapshot.worlds.map((rel) => ({ from: rel, to: `${folder}${target(rel)}` }));
	const from = snapshotPath(root, snapshot.id);
	const taskId = startTask({ label: `New world from a snapshot: ${instance.name}`, instanceId: instance.id }, async (task) => {
		const incoming = path.join(root, '.mineshell', `world-incoming-${Date.now()}`);
		try {
			task.setProgress(null, `Copying snapshot ${snapshot.id}`);
			for (const { from: rel, to } of mapped) {
				await fs.mkdir(path.dirname(path.join(incoming, to)), { recursive: true });
				await fs.cp(path.join(from, rel), path.join(incoming, to), {
					recursive: true,
					preserveTimestamps: true,
					mode: fsConstants.COPYFILE_FICLONE
				});
			}
			if ((await Promise.all(mapped.map(({ to }) => exists(path.join(root, to))))).some(Boolean)) {
				throw new InstanceError(`Something named ${folder} appeared in the server folder meanwhile; try again.`);
			}
			for (const { to } of mapped) await fs.rename(path.join(incoming, to), path.join(root, to));
			const meta = await readWorldMeta(root);
			meta.worlds[folder] = {
				name,
				createdAt: Date.now(),
				sizeBytes: await worldBytes(root, folder),
				lastRun: {
					minecraftVersion: snapshot.minecraftVersion,
					modloader: snapshot.modloader,
					modloaderVersion: snapshot.modloaderVersion,
					packVersionName: snapshot.packVersionName
				}
			};
			await writeWorldMeta(root, meta);
			audit('instance.world_created', { instanceId: instance.id, detail: `${folder} from ${snapshot.id}` });
			task.log(`${name} is a world of its own now (folder ${folder}); switch to it under Worlds.`);
			task.setProgress(100, 'Ready');
		} finally {
			await fs.rm(incoming, { recursive: true, force: true });
		}
	});
	return { taskId, folder };
}

// ------------------------------------------------------------ uploads ---

export function openZip(file: string): Promise<yauzl.ZipFile> {
	return new Promise((resolve, reject) =>
		yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip)))
	);
}

export async function zipEntries(zip: yauzl.ZipFile, onEntry: (entry: yauzl.Entry) => Promise<void>): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		zip.on('entry', (entry: yauzl.Entry) => {
			onEntry(entry).then(() => zip.readEntry(), reject);
		});
		zip.on('end', () => resolve());
		zip.on('error', reject);
		zip.readEntry();
	});
}

export function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
	return new Promise((resolve, reject) =>
		zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)))
	);
}

/**
 * The folder inside an uploaded zip that is the world: the shallowest one
 * holding a level.dat. A world zipped from its folder has it at the top, one
 * zipped from the saves folder one level down.
 */
export function worldRootIn(names: string[]): string | null {
	const roots = names
		.filter((n) => n === 'level.dat' || n.endsWith('/level.dat'))
		.map((n) => n.slice(0, -'level.dat'.length))
		.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
	return roots[0] ?? null;
}

/** A zip entry's path below the world root, or null for one outside it or escaping it. */
export function entryTarget(name: string, prefix: string): string | null {
	if (!name.startsWith(prefix)) return null;
	const rel = name.slice(prefix.length).replace(/\\/g, '/');
	if (!rel || rel.startsWith('/')) return null;
	const normal = path.posix.normalize(rel);
	if (normal === '.' || normal.startsWith('../') || normal === '..' || normal.split('/').includes('..')) return null;
	return normal;
}

async function zipNames(file: string): Promise<string[]> {
	const zip = await openZip(file);
	const names: string[] = [];
	try {
		await zipEntries(zip, async (entry) => {
			names.push(entry.fileName);
		});
	} finally {
		zip.close();
	}
	return names;
}

/** Unpacks the world inside a zip (its folder holding level.dat is `prefix`) into `target`. */
async function unpackWorld(zipFile: string, names: string[], prefix: string, target: string, task: TaskHandle): Promise<void> {
	task.setProgress(0, 'Unpacking the uploaded world');
	await fs.mkdir(target, { recursive: true });
	const total = names.length;
	let done = 0;
	const zip = await openZip(zipFile);
	try {
		await zipEntries(zip, async (entry) => {
			done++;
			const rel = entryTarget(entry.fileName, prefix);
			if (!rel) return;
			const out = path.join(target, rel);
			if (entry.fileName.endsWith('/')) {
				await fs.mkdir(out, { recursive: true });
				return;
			}
			await fs.mkdir(path.dirname(out), { recursive: true });
			await pipeline(await entryStream(zip, entry), createWriteStream(out));
			if (done % 200 === 0) task.setProgress(Math.round((done / total) * 100));
		});
	} finally {
		zip.close();
	}
	// The lock of whoever zipped it; the server writes its own.
	await fs.rm(path.join(target, 'session.lock'), { force: true });
}

/** The zip's entry names and the folder in it holding level.dat; the zip is deleted when it holds no world. */
async function worldInZip(zipFile: string): Promise<{ names: string[]; prefix: string }> {
	let names: string[];
	try {
		names = await zipNames(zipFile);
	} catch {
		await fs.rm(zipFile, { force: true });
		throw new InstanceError('That file is not a readable zip.');
	}
	const prefix = worldRootIn(names);
	if (prefix === null) {
		await fs.rm(zipFile, { force: true });
		throw new InstanceError('There is no level.dat in that zip, so it is not a Minecraft world.');
	}
	return { names, prefix };
}

/**
 * An uploaded zip (saved to `zipFile`, deleted afterwards) as a new world
 * beside the others. Inactive, the server may run meanwhile; `activate` makes
 * it the active world once unpacked, which needs a stopped server (checked
 * before and again then). Unpacked in a `world-incoming-` folder, which
 * recovery removes when cut short.
 */
export async function worldFromZip(
	instance: ServerInstance,
	zipFile: string,
	rawName: string,
	opts: { activate?: { keepMap: boolean } } = {}
): Promise<{ taskId: string; folder: string }> {
	let name: string;
	try {
		name = cleanWorldName(rawName);
		if (opts.activate) await requireSwitchable(instance);
	} catch (err) {
		await fs.rm(zipFile, { force: true });
		throw err instanceof InstanceError ? err : new InstanceError((err as Error).message);
	}
	const { names, prefix } = await worldInZip(zipFile);
	const root = instance.path;
	const folder = await freeWorldFolder(root, name);
	const taskId = startTask({ label: `New world from an upload: ${instance.name}`, instanceId: instance.id }, async (task) => {
		const incoming = path.join(root, '.mineshell', `world-incoming-${Date.now()}`);
		try {
			await unpackWorld(zipFile, names, prefix, path.join(incoming, folder), task);
			if (await exists(path.join(root, folder))) throw new InstanceError(`Something named ${folder} appeared in the server folder meanwhile; try again.`);
			await fs.rename(path.join(incoming, folder), path.join(root, folder));
			const meta = await readWorldMeta(root);
			meta.worlds[folder] = { name, createdAt: Date.now(), sizeBytes: await worldBytes(root, folder) };
			await writeWorldMeta(root, meta);
			audit('instance.world_created', { instanceId: instance.id, detail: `${folder} from an upload` });
			if (opts.activate) await activateUploaded(instance.id, folder, opts.activate.keepMap, task);
			else task.log(`${name} is a world of its own now (folder ${folder}); switch to it under Worlds.`);
			task.setProgress(100, 'Ready');
		} finally {
			await fs.rm(incoming, { recursive: true, force: true });
			await fs.rm(zipFile, { force: true });
		}
	});
	return { taskId, folder };
}

/**
 * Makes an uploaded world active, unless that is no longer safe: the server
 * was started during the upload, or the world is from a newer Minecraft
 * (switching asks about that). Then it stays inactive, and the log says why.
 */
async function activateUploaded(instanceId: string, folder: string, keepMap: boolean, task: TaskHandle): Promise<void> {
	const fresh = getInstance(instanceId);
	const world = fresh && (await listWorlds(fresh)).find((w) => w.folder === folder);
	if (!fresh || !world) return;
	const refusal = await requireSwitchable(fresh).then(
		() => newerWorldWarning(fresh, world),
		(err) => (err instanceof Error ? err.message : 'It cannot be switched to now.')
	);
	if (refusal) {
		task.log(`${world.name} was not made the active world: ${refusal} It is under Worlds, to switch to.`);
		return;
	}
	task.setProgress(null, 'Making it the active world');
	await activateWorld(fresh, folder, { keepMap, properties: { 'level-seed': '' }, packDatapacks: null });
	task.log(`${world.name} is the active world now; the server loads it on its next start.`);
}

/**
 * Replace the world with an uploaded zip (already saved to `zipFile`, which
 * is deleted once the change has run). Checked before anything starts: the
 * zip must hold a world.
 */
export async function replaceWorld(instance: ServerInstance, zipFile: string, opts: { snapshot: boolean }): Promise<string> {
	const { names, prefix } = await worldInZip(zipFile);
	const level = await serverWorldName(instance.path);
	try {
		return await runWorldChange(instance, {
			action: 'replace',
			label: 'Replacing the world',
			snapshot: opts.snapshot,
			placing: [level],
			assemble: (incoming, task) => unpackWorld(zipFile, names, prefix, path.join(incoming, level), task),
			done: 'Replaced the world with the uploaded one.',
			afterwards: () => fs.rm(zipFile, { force: true })
		});
	} catch (err) {
		// Refused before the task started.
		await fs.rm(zipFile, { force: true });
		throw err;
	}
}

// ---------------------------------------------------------- downloads ---

async function listFiles(dir: string, base: string, out: { abs: string; rel: string }[]): Promise<void> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		const rel = path.posix.join(base, entry.name);
		if (entry.isDirectory()) await listFiles(abs, rel, out);
		else if (entry.isFile()) out.push({ abs, rel });
	}
}

/** Region files are compressed already; deflating them again only costs time. */
/** Already compressed: stored as they are in a zip, not deflated again. */
export const STORED = /\.(mca|mcr|mcc|png|gz|zip)$/i;

/**
 * A zip of world folders under `dir`, streamed while it is built. Entries
 * are `<world>/...`, as a world is zipped by hand.
 */
export async function zipWorlds(dir: string, worlds: string[]): Promise<Readable> {
	const files: { abs: string; rel: string }[] = [];
	for (const world of worlds) await listFiles(path.join(dir, world), path.posix.basename(world), files);
	const zip = new yazl.ZipFile();
	for (const file of files) {
		if (path.posix.basename(file.rel) === 'session.lock') continue;
		zip.addFile(file.abs, file.rel, { compress: !STORED.test(file.rel) });
	}
	zip.end();
	return zip.outputStream as Readable;
}

export type WorldDownload = { stream: Readable; fileName: string };

/**
 * The world, one snapshot of it, or one of the server's other worlds, as a
 * zip. A running server is told to stop writing (save-off, save-all flush)
 * until the zip of its active world is done, and save-on is sent however the
 * download ends; the other worlds it does not touch.
 */
export async function downloadWorld(instance: ServerInstance, snapshotId: string | null, worldFolder: string | null = null): Promise<WorldDownload> {
	const safeName = instance.id;
	if (worldFolder && worldFolder !== (await serverWorldName(instance.path))) {
		const world = (await listWorlds(instance)).find((w) => w.folder === worldFolder);
		if (!world?.folders.length) throw new InstanceError('That world is not on this server.');
		return { stream: await zipWorlds(instance.path, world.folders), fileName: `${safeName}-${path.posix.basename(world.folder)}.zip` };
	}
	if (snapshotId) {
		const snapshot: Snapshot | null = await getSnapshot(instance.path, snapshotId);
		if (!snapshot) throw new InstanceError('That snapshot no longer exists.');
		return {
			stream: await zipWorlds(snapshotPath(instance.path, snapshot.id), snapshot.worlds),
			fileName: `${safeName}-${snapshot.id}.zip`
		};
	}
	const worlds = await worldFolders(instance.path);
	if (!worlds.length) throw new InstanceError('There is no world yet.');
	const fileName = `${safeName}-world.zip`;
	const { running } = await summarise(instance);
	if (!running) return { stream: await zipWorlds(instance.path, worlds), fileName };

	const password = rconPassword(instance);
	if (!password) throw new InstanceError('RCON is not set up for this server; stop it to download the world.');
	const rcon = (commands: string[]) => rconExec({ port: instance.rconPort, password }, commands);
	try {
		await rcon(['save-off', 'save-all flush']);
	} catch {
		throw new InstanceError('The server did not answer over RCON, so saving could not be paused. Stop it to download the world.');
	}
	let resumed = false;
	const resume = () => {
		if (resumed) return;
		resumed = true;
		void rcon(['save-on']).catch(() => {
			setStatus(instance.id, 'ready', 'Saving was paused for a world download and could not be turned back on. Run "save-on" in the console.');
		});
	};
	try {
		const stream = await zipWorlds(instance.path, worlds);
		stream.once('close', resume);
		stream.once('end', resume);
		stream.once('error', resume);
		return { stream, fileName };
	} catch (err) {
		resume();
		throw err;
	}
}
