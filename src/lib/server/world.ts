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
import { formatBytes } from '$lib/shared/format';
import { findDimension, listDimensions, type Dimension } from './dimensions';
import { applyPrune, planPrune, type PruneOptions } from './chunkprune';
import { child, parseNbt } from './nbt';
import { constants as fsConstants } from 'node:fs';
import {
	finishSnapshot,
	getSnapshot,
	getSnapshotPolicy,
	newSnapshotId,
	partialPath,
	pruneSnapshots,
	snapshotPath,
	snapshotPrompt,
	snapshotStep,
	worldFolders,
	type Snapshot
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
	const properties =
		opts.seed.mode === 'random' ? { 'level-seed': '' } : opts.seed.mode === 'set' ? { 'level-seed': opts.seed.seed } : undefined;
	return runWorldChange(instance, {
		action: 'reset',
		label: 'Resetting the world',
		snapshot: opts.snapshot,
		placing: [],
		properties,
		done: 'The world is gone; the next start generates a new one.'
	});
}

/** Put a snapshot's world back in place of the current one. */
export async function restoreSnapshot(instance: ServerInstance, id: string, opts: { snapshot: boolean }): Promise<string> {
	const snapshot = await getSnapshot(instance.path, id);
	if (!snapshot) throw new InstanceError('That snapshot no longer exists.');
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

export type PruneCount = PruneSettings & {
	dimension: string;
	label: string;
	chunks: number;
	remove: number;
	unreadable: number;
	bytes: number;
	at: number;
};

/** The last count per server, for the World tab; in memory, a count is quick to redo. */
const pruneCounts = new Map<string, PruneCount>();

export function lastPruneCount(instanceId: string): PruneCount | null {
	return pruneCounts.get(instanceId) ?? null;
}

/** The world spawn from level.dat (Data.SpawnX/SpawnZ); null when unreadable. */
async function worldSpawn(root: string): Promise<{ x: number; z: number } | null> {
	try {
		const level = parseNbt(await fs.readFile(path.join(root, await serverWorldName(root), 'level.dat')));
		const data = child(level.root, 'Data');
		const x = child(data, 'SpawnX');
		const z = child(data, 'SpawnZ');
		return x?.type === 'int' && z?.type === 'int' ? { x: x.value, z: z.value } : null;
	} catch {
		return null;
	}
}

/** The folder holding a dimension's region/: the world folder for the overworld, else the dimension's own. */
function dimensionBase(root: string, dimension: Dimension): string {
	return path.join(root, dimension.overworld ? path.dirname(dimension.paths[0]) : dimension.paths[0]);
}

async function pruneOptions(root: string, dimension: Dimension, settings: PruneSettings): Promise<PruneOptions> {
	const spawn = dimension.overworld && settings.keepAroundSpawn > 0 ? await worldSpawn(root) : null;
	return { maxTicks: settings.maxTicks, keep: spawn ? { ...spawn, radius: settings.keepAroundSpawn } : null };
}

function validSettings(settings: PruneSettings): PruneSettings {
	if (!Number.isInteger(settings.maxTicks) || settings.maxTicks < 1) throw new InstanceError('Pick how long a chunk must have been visited to stay.');
	if (!Number.isInteger(settings.keepAroundSpawn) || settings.keepAroundSpawn < 0) throw new InstanceError('The radius to keep is a whole number of blocks.');
	return settings;
}

/**
 * Counts what pruning would remove, without changing anything. Reads only, so
 * it also runs while the server is up (the count is then a moment's picture).
 */
export async function countPrunable(instance: ServerInstance, key: string, settings: PruneSettings): Promise<string> {
	validSettings(settings);
	const dimension = await findDimension(instance.path, key);
	if (!dimension) throw new InstanceError('That dimension is not in the world.');
	const opts = await pruneOptions(instance.path, dimension, settings);
	return startTask({ label: `Counting chunks to prune in ${dimension.label}: ${instance.name}`, instanceId: instance.id }, async (task) => {
		const plan = await planPrune(dimensionBase(instance.path, dimension), opts, (done, total) =>
			task.setProgress(total ? (done / total) * 100 : null, `Reading region file ${done} of ${total}`)
		);
		pruneCounts.set(instance.id, {
			...settings,
			dimension: key,
			label: dimension.label,
			chunks: plan.chunks,
			remove: plan.remove,
			unreadable: plan.unreadable,
			bytes: plan.bytes,
			at: Date.now()
		});
		task.log(`${plan.remove} of ${plan.chunks} chunks would go${plan.unreadable ? `; ${plan.unreadable} could not be read and stay` : ''}.`);
	});
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
	opts: { snapshot: boolean }
): Promise<string> {
	validSettings(settings);
	const dimension = await findDimension(instance.path, key);
	if (!dimension) throw new InstanceError('That dimension is not in the world.');
	const pruneOpts = await pruneOptions(instance.path, dimension, settings);
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
			const plan = await planPrune(base, pruneOpts, (done, total) =>
				task.setProgress(total ? (done / total) * 90 : null, `Reading region file ${done} of ${total}`)
			);
			task.setProgress(null, `Removing ${plan.remove} chunks`);
			await applyPrune(base, plan);
			pruneCounts.delete(instance.id);
			task.log(
				`Removed ${plan.remove} of ${plan.chunks} chunks${plan.unreadable ? `; ${plan.unreadable} could not be read and stayed` : ''}.`
			);
		},
		done: `${dimension.label} is pruned; removed chunks generate again when someone goes there.`
	});
}

/** Take a snapshot now, outside any other operation. */
export async function snapshotNow(instance: ServerInstance): Promise<string> {
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
	const taskId = startTask({ label: `Snapshot ${instance.name}`, instanceId: instance.id }, async (task) => {
		try {
			await snapshotStep(instance, { reason: 'manual', label: 'Taken by hand' }, task);
		} catch (err) {
			endOperation(instance.id);
			setStatus(instance.id, 'ready', `Snapshotting the world failed: ${err instanceof Error ? err.message : 'unknown error'}`);
			throw err;
		}
		commitOperation(instance.id, { status: 'ready', statusMessage: null });
		task.setProgress(100, 'Ready');
	});
	return taskId;
}

// ------------------------------------------------------------ uploads ---

function openZip(file: string): Promise<yauzl.ZipFile> {
	return new Promise((resolve, reject) =>
		yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip)))
	);
}

async function zipEntries(zip: yauzl.ZipFile, onEntry: (entry: yauzl.Entry) => Promise<void>): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		zip.on('entry', (entry: yauzl.Entry) => {
			onEntry(entry).then(() => zip.readEntry(), reject);
		});
		zip.on('end', () => resolve());
		zip.on('error', reject);
		zip.readEntry();
	});
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
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

/**
 * Replace the world with an uploaded zip (already saved to `zipFile`, which
 * is deleted once the change has run). Checked before anything starts: the
 * zip must hold a world.
 */
export async function replaceWorld(instance: ServerInstance, zipFile: string, opts: { snapshot: boolean }): Promise<string> {
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
	const level = await serverWorldName(instance.path);
	try {
		return await runWorldChange(instance, {
			action: 'replace',
			label: 'Replacing the world',
			snapshot: opts.snapshot,
			placing: [level],
			assemble: async (incoming, task) => {
				task.setProgress(0, 'Unpacking the uploaded world');
				const target = path.join(incoming, level);
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
			},
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
const STORED = /\.(mca|mcr|mcc|png|gz|zip)$/i;

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
 * The world, or one snapshot of it, as a zip. A running server is told to
 * stop writing (save-off, save-all flush) until the zip is done, and
 * save-on is sent however the download ends.
 */
export async function downloadWorld(instance: ServerInstance, snapshotId: string | null): Promise<WorldDownload> {
	const safeName = instance.id;
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
