import fs from 'node:fs/promises';
import { deletePruneArea, listPruneAreas, PruneAreaError, savePruneArea } from '#lib/server/pruneareas.js';
import path from 'node:path';
import { fail } from '@sveltejs/kit';
import { requireAccess, requireGlobalAdmin } from '#lib/server/access.js';
import { backupView, copyBack, isServerFolderName } from '#lib/server/backups.js';
import type { Actions, PageServerLoad } from './$types';
import { InstanceError, requireInstance, summarise } from '#lib/server/instances.js';
import { readProperties } from '#lib/server/properties.js';
import { serverWorldName } from '#lib/server/packworld.js';
import {
	decideSnapshot,
	deleteSnapshot,
	getSnapshot,
	listSnapshots,
	setSnapshotDetails,
	setSnapshotPinned,
	snapshotDetails,
	snapshotOfWorld,
	snapshotPrompt,
	snapshotUsage,
	SnapshotChoiceNeeded,
	worldFolders
} from '#lib/server/snapshots.js';
import {
	analysePrunable,
	parseChunkList,
	pruneAnalysisSummary,
	runningPruneAnalysis,
	pruneChunks,
	resetDimension,
	resetWorld,
	restoreDimension,
	restoreSnapshot,
	snapshotDimensions,
	snapshotNow,
	switchWorld,
	createWorld,
	renameWorld,
	deleteWorld,
	worldFromSnapshot,
	worldBorder,
	worldSeed,
	worldSpawn,
	WorldVersionError,
	type SeedChoice
} from '#lib/server/world.js';
import { listWorlds, newerWorldWarning, otherLoaderWarning, snapshotWorldFolder, withSizes } from '#lib/server/worlds.js';
import { webRoot } from '#lib/server/worldmap.js';
import { snapshotWhileRunning } from '#lib/server/snapshotschedule.js';
import { listDimensions, MODERN_OVERWORLD, type Dimension } from '#lib/server/dimensions.js';
import type { PregenShape } from '#lib/shared/pregen.js';
import { withDimensionNames } from '#lib/server/dimensionnames.js';
import { getTask } from '#lib/server/tasks.js';
import { backupModNote, backupModsOf } from '#lib/server/backupmods.js';
import {
	cancelPregen,
	chunkyLanguage,
	chunkyStatus,
	continuesOnRestart,
	ChunkyError,
	confirmPregen,
	continuePregen,
	hasChunky,
	pausedForPlayers,
	pausePregen,
	pausesForPlayers,
	savedTasks,
	setContinuesOnRestart,
	setPausesForPlayers,
	startPregen
} from '#lib/server/chunky.js';

export const load: PageServerLoad = async ({ params, url, locals }) => {
	const instance = requireInstance(params.id);
	const { values } = await readProperties(instance.path);
	const running = (await summarise(instance)).running;
	const levelName = await serverWorldName(instance.path);
	const worlds = await withSizes(instance, await listWorlds(instance));
	const folders = worlds.map((w) => w.folder);
	const snapshots = await listSnapshots(instance.path);
	return {
		running,
		chunky: (await hasChunky(instance.path)) ? await chunkyData(instance, running) : null,
		levelName,
		worlds: await worldFolders(instance.path),
		seed: values['level-seed'] ?? '',
		/** The seed the world was made with (level.dat); with level-seed blank, the random one it got. */
		worldSeed: await worldSeed(instance.path),
		snapshotPrompt: await snapshotPrompt(instance),
		/** Mods that copy the world too, as a sentence each; unawaited, their folders are measured. */
		backupMods: backupModsOf(instance).then((found) => found.map((m) => ({ name: m.name, note: backupModNote(m), bytes: m.bytes }))),
		/** What the snapshots take on disk: files they share counted once. */
		snapshotDiskBytes: (await snapshotUsage(instance.path)).bytes,
		// Dimensions travel to the page as the first of their folders, which is how actions name them.
		dimensions: (await withDimensionNames(instance, await listDimensions(instance.path))).map(dimensionOption),
		pruneAnalysis: pruneAnalysisSummary(instance.id),
		/** Named areas every prune of their dimension skips. */
		pruneAreas: listPruneAreas(instance.id),
		pruneAnalysing: analysingNow(instance.id),
		// Copies of another server's snapshots there (one that is gone, made again) are for global admins.
		backups: await backupView(instance, backupsOf(url, locals) ?? instance.id),
		snapshots: await Promise.all(
			snapshots.map(async (s) => {
				// Only one of the world the server uses can be restored (snapshotOfWorld).
				const ofThisWorld = snapshotOfWorld(s, levelName);
				return {
					...s,
					ofThisWorld,
					worldFolder: ofThisWorld ? levelName : snapshotWorldFolder(s, folders),
					dimensions: ofThisWorld ? (await withDimensionNames(instance, await snapshotDimensions(instance, s))).map(dimensionOption) : []
				};
			})
		),
		serverWorlds: worlds.map((w) => ({
			...w,
			snapshots: snapshots.filter((s) => (snapshotOfWorld(s, levelName) ? levelName : snapshotWorldFolder(s, folders)) === w.folder).length,
			newer: newerWorldWarning(instance, w),
			otherLoader: otherLoaderWarning(instance, w)
		})),
		/** BlueMap's render of the active world exists: switching asks whether to keep it. */
		mapRendered: await fs.access(path.join(webRoot(instance.id), 'index.html')).then(() => true, () => false),
		datapackCount: (await fs.readdir(path.join(instance.path, levelName, 'datapacks')).catch(() => [])).length,
		packServer: !!instance.packSource,
		current: {
			minecraftVersion: instance.minecraftVersion,
			modloader: instance.modloader,
			modloaderVersion: instance.modloaderVersion,
			packVersionName: instance.packVersionName
		}
	};
};

/** The server folder in the backup folder the page lists, when it is another server's. */
function backupsOf(url: URL, locals: App.Locals): string | null {
	const of = url.searchParams.get('backupsOf');
	return of && locals.access.globalAdmin && isServerFolderName(of) ? of : null;
}

/**
 * Chunky's state for the pre-generation panel. Saved tasks not cancelled are
 * the ones that can be continued (a finished task is saved as cancelled).
 */
async function chunkyData(instance: ReturnType<typeof requireInstance>, running: boolean) {
	const status = running ? await chunkyStatus(instance).catch(() => null) : null;
	const runningWorlds = new Set(status?.running.map((t) => t.world) ?? []);
	return {
		status,
		unfinished: (await savedTasks(instance.path)).filter((t) => !t.cancelled && !runningWorlds.has(t.world)),
		english: (await chunkyLanguage(instance.path)) === 'en',
		pauseForPlayers: pausesForPlayers(instance.id),
		pausedForPlayers: pausedForPlayers(instance.id),
		continueOnRestart: continuesOnRestart(instance.id),
		dimensions: await pregenDimensions(instance)
	};
}

const VANILLA_DIMENSIONS = [
	{ id: 'minecraft:overworld', label: 'Overworld', folder: '' },
	{ id: 'minecraft:the_nether', label: 'The Nether', folder: 'DIM-1' },
	{ id: 'minecraft:the_end', label: 'The End', folder: 'DIM1' }
];

/**
 * What Chunky can be pointed at: the vanilla three (a dimension nobody has
 * visited has no folder yet, but Chunky generates it all the same) and every
 * other one with a folder and an id. `key` names the folder for the chunk map;
 * spawn and border are offered as the selection's middle.
 */
async function pregenDimensions(instance: ReturnType<typeof requireInstance>) {
	const onDisk = (await withDimensionNames(instance, await listDimensions(instance.path))).filter((d) => d.id.includes(':'));
	const spawn = await worldSpawn(instance.path);
	const level = await serverWorldName(instance.path);
	// A vanilla dimension without terrain yet can still have its border file (1.21.11 makes all three),
	// from Minecraft 26 in dimensions/minecraft/ beside the overworld.
	const modern = await fs.access(path.join(instance.path, level, MODERN_OVERWORLD)).then(
		() => true,
		() => false
	);
	const folderOf = (v: (typeof VANILLA_DIMENSIONS)[number]) =>
		modern
			? path.join(level, 'dimensions', 'minecraft', v.id.slice('minecraft:'.length), ...(v.folder ? [] : ['region']))
			: path.join(level, v.folder || 'region');
	const entries: { id: string; label: string; dimension: Dimension | null; borderFrom: Dimension }[] = [
		...VANILLA_DIMENSIONS.map((v) => {
			const dimension = onDisk.find((d) => d.id === v.id) ?? null;
			const unvisited = { id: v.id, label: v.label, paths: [folderOf(v)], overworld: !v.folder };
			return { id: v.id, label: dimension?.label ?? v.label, dimension, borderFrom: dimension ?? unvisited };
		}),
		...onDisk.filter((d) => !VANILLA_DIMENSIONS.some((v) => v.id === d.id)).map((d) => ({ id: d.id, label: d.label, dimension: d, borderFrom: d }))
	];
	return Promise.all(
		entries.map(async ({ id, label, dimension, borderFrom }) => ({
			id,
			label,
			key: dimension?.paths[0] ?? null,
			spawn: spawn && spawn.dimension === id ? { x: spawn.x, z: spawn.z } : null,
			border: await worldBorder(instance.path, borderFrom)
		}))
	);
}

/** The analysis under way with its task's state, so the page's first paint already shows how far it is. */
function analysingNow(instanceId: string) {
	const running = runningPruneAnalysis(instanceId);
	const task = running?.taskId ? getTask(running.taskId) : undefined;
	if (!running || !task) return null;
	return { taskId: running.taskId, task: { id: task.id, state: task.state, progress: task.progress, step: task.step, error: task.error } };
}

const dimensionOption = (d: Dimension) => ({ key: d.paths[0], label: d.label, overworld: d.overworld });

function chunkyRefused(err: unknown) {
	if (err instanceof ChunkyError) return fail(400, { ok: false, message: err.message });
	throw err;
}

const pruneSettings = (form: FormData) => ({
	maxTicks: Number(form.get('maxTicks')),
	keepAroundSpawn: Number(form.get('keepAroundSpawn') ?? 0)
});

const worldOf = (form: FormData) => String(form.get('world') ?? '') || null;

function refused(err: unknown) {
	if (err instanceof InstanceError || err instanceof SnapshotChoiceNeeded) return fail(400, { ok: false, message: err.message });
	throw err;
}

const STARTED = 'Follow it in Activity; the server stays stopped until it finishes.';

export const actions: Actions = {
	chunkyStart: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const custom = String(form.get('customWorld') ?? '').trim();
		const world = String(form.get('world')) === 'other' ? custom : String(form.get('world') ?? '');
		try {
			const result = await startPregen(instance, {
				world,
				shape: String(form.get('shape') ?? '') as PregenShape,
				centerX: Number(form.get('centerX') || 0),
				centerZ: Number(form.get('centerZ') || 0),
				radius: Number(form.get('radius')),
				radiusZ: Number(form.get('radiusZ'))
			});
			return result.needsConfirm
				? { ok: true, message: result.text, chunkyConfirm: world }
				: { ok: true, message: result.text || 'Started.' };
		} catch (err) {
			return chunkyRefused(err);
		}
	},

	chunkyConfirm: async ({ params }) => {
		try {
			return { ok: true, message: (await confirmPregen(requireInstance(params.id))) || 'Started over.' };
		} catch (err) {
			return chunkyRefused(err);
		}
	},

	chunkyPause: async ({ request, params }) => {
		try {
			return { ok: true, message: (await pausePregen(requireInstance(params.id), worldOf(await request.formData()))) || 'Paused.' };
		} catch (err) {
			return chunkyRefused(err);
		}
	},

	chunkyContinue: async ({ request, params }) => {
		try {
			return { ok: true, message: (await continuePregen(requireInstance(params.id), worldOf(await request.formData()))) || 'Continuing.' };
		} catch (err) {
			return chunkyRefused(err);
		}
	},

	chunkyCancel: async ({ request, params }) => {
		try {
			return { ok: true, message: (await cancelPregen(requireInstance(params.id), worldOf(await request.formData()))) || 'Cancelled.' };
		} catch (err) {
			return chunkyRefused(err);
		}
	},

	chunkyAuto: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const enabled = (await request.formData()).get('enabled') === 'true';
		setPausesForPlayers(instance.id, enabled);
		return {
			ok: true,
			message: enabled
				? 'Pre-generation now pauses while anyone is online and continues when the server is empty.'
				: 'Pre-generation no longer pauses for players.'
		};
	},

	chunkyRestart: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const enabled = (await request.formData()).get('enabled') === 'true';
		await setContinuesOnRestart(instance, enabled);
		return {
			ok: true,
			message: enabled
				? 'Unfinished pre-generation now continues when the server starts again.'
				: 'Unfinished pre-generation now waits for Continue after the server restarts.'
		};
	},

	snapshot: async ({ params }) => {
		const instance = requireInstance(params.id);
		try {
			// Running: copied with saving paused, as scheduled snapshots are.
			if ((await summarise(instance)).running) {
				await snapshotWhileRunning(instance);
				return { ok: true, message: 'Snapshotting the world while it runs, with saving paused for the copy. Follow it in Activity.' };
			}
			await snapshotNow(instance);
			return { ok: true, message: `Snapshotting the world. ${STARTED}` };
		} catch (err) {
			return refused(err);
		}
	},

	restore: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const dimension = String(form.get('dimension') ?? '');
		try {
			const snapshot = await decideSnapshot(instance, form.get('snapshot'), { moves: true });
			if (dimension) {
				await restoreDimension(instance, String(form.get('id') ?? ''), dimension, { snapshot });
				return { ok: true, message: `Restoring one dimension from the snapshot. ${STARTED}` };
			}
			await restoreSnapshot(instance, String(form.get('id') ?? ''), { snapshot });
			return { ok: true, message: `Restoring the snapshot. ${STARTED}` };
		} catch (err) {
			return refused(err);
		}
	},

	copyBack: async ({ request, params, locals }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const from = String(form.get('from') || instance.id);
		if (from !== instance.id) requireGlobalAdmin(locals);
		try {
			await copyBack(instance, String(form.get('id') ?? ''), from);
			return { ok: true, message: 'Copying the snapshot back; it shows under Snapshots when the task finishes. Pin it if it should stay a while.' };
		} catch (err) {
			if (err instanceof InstanceError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
	},

	pinSnapshot: async ({ request, params, locals }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const pinned = form.get('pinned') === 'true';
		// Unpinned, retention may delete it.
		if (!pinned) requireAccess(locals, instance.id, 'backups.delete');
		try {
			await setSnapshotPinned(instance.path, String(form.get('id') ?? ''), pinned);
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Could not change that snapshot.' });
		}
		return { ok: true, message: pinned ? 'Pinned: kept until you unpin it.' : 'Unpinned: it counts towards the limit again.' };
	},

	editSnapshot: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			const details = snapshotDetails(String(form.get('note') ?? ''), String(form.get('tags') ?? ''));
			await setSnapshotDetails(instance.path, String(form.get('id') ?? ''), details);
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Could not change that snapshot.' });
		}
		return { ok: true, message: 'Snapshot saved.' };
	},

	deleteSnapshot: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const id = String((await request.formData()).get('id') ?? '');
		// A restore copies from it while running.
		if (instance.status === 'provisioning') return fail(400, { ok: false, message: 'Wait for the current operation to finish.' });
		if (!(await getSnapshot(instance.path, id))) return fail(400, { ok: false, message: 'That snapshot no longer exists.' });
		await deleteSnapshot(instance.path, id);
		return { ok: true, message: 'Snapshot deleted.' };
	},

	pruneAnalyse: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			// Its progress shows by the button (PruneMap follows the task at once), not as a message.
			return { ok: true, taskId: await analysePrunable(instance, String(form.get('dimension') ?? '')) };
		} catch (err) {
			return refused(err);
		}
	},

	prune: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			await pruneChunks(instance, String(form.get('dimension') ?? ''), pruneSettings(form), {
				snapshot: await decideSnapshot(instance, form.get('snapshot'), { moves: true }),
				analysedAt: Number(form.get('analysedAt')),
				protect: parseChunkList(String(form.get('protect') ?? ''))
			});
			return { ok: true, message: `Pruning. ${STARTED}` };
		} catch (err) {
			return refused(err);
		}
	},

	savePruneArea: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			const area = savePruneArea(instance.id, String(form.get('dimension') ?? ''), String(form.get('name') ?? ''), parseChunkList(String(form.get('chunks') ?? '')));
			return { ok: true, message: `Saved ${area.name}: every prune of this dimension skips its ${area.chunks.length} chunk${area.chunks.length === 1 ? '' : 's'}.` };
		} catch (err) {
			if (err instanceof PruneAreaError) return fail(400, { ok: false, message: err.message });
			return refused(err);
		}
	},

	deletePruneArea: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		if (!deletePruneArea(instance.id, String((await request.formData()).get('id') ?? ''))) return fail(400, { ok: false, message: 'That area is gone already.' });
		return { ok: true, message: 'Deleted the area; its chunks can be pruned again.' };
	},

	resetDimension: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			await resetDimension(instance, String(form.get('dimension') ?? ''), {
				snapshot: await decideSnapshot(instance, form.get('snapshot'), { moves: true })
			});
			return { ok: true, message: `Resetting the dimension. ${STARTED}` };
		} catch (err) {
			return refused(err);
		}
	},

	switchWorld: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const folder = String(form.get('world') ?? '');
		try {
			await switchWorld(instance, folder, { keepMap: form.get('keepMap') === 'on', force: form.get('force') === 'on' });
		} catch (err) {
			if (err instanceof WorldVersionError) return fail(400, { ok: false, message: err.message, newerWorld: folder });
			return refused(err);
		}
		const name = (await listWorlds(instance)).find((w) => w.folder === folder)?.name ?? folder;
		return { ok: true, message: `${name} is the active world now; the server loads it on its next start.` };
	},

	createWorld: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const seed = String(form.get('seedMode')) === 'set' ? String(form.get('seed') ?? '').trim() : null;
		if (seed === '') return fail(400, { ok: false, message: 'Enter the seed to use.' });
		try {
			await createWorld(instance, {
				name: String(form.get('name') ?? ''),
				seed,
				copyDatapacks: form.get('copyDatapacks') === 'on',
				keepMap: form.get('keepMap') === 'on'
			});
		} catch (err) {
			return refused(err);
		}
		return { ok: true, message: 'The new world is the active one; the server generates it on its next start.' };
	},

	renameWorld: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			await renameWorld(instance, String(form.get('world') ?? ''), String(form.get('name') ?? ''));
		} catch (err) {
			return refused(err);
		}
		return { ok: true, message: 'Renamed.' };
	},

	deleteWorld: async ({ request, params, locals }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const snapshots = form.get('snapshots') === 'on';
		if (snapshots) requireAccess(locals, instance.id, 'backups.delete');
		try {
			const removed = await deleteWorld(instance, String(form.get('world') ?? ''), { snapshots });
			return {
				ok: true,
				message: `World deleted; its folders are in the trash (Files) for now.${removed ? ` ${removed} snapshot${removed === 1 ? '' : 's'} of it deleted too.` : ''}`
			};
		} catch (err) {
			return refused(err);
		}
	},

	worldFromSnapshot: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			await worldFromSnapshot(instance, String(form.get('id') ?? ''), String(form.get('name') ?? ''));
			return { ok: true, message: 'Copying the snapshot into a new world; it shows under Worlds when the task finishes.' };
		} catch (err) {
			return refused(err);
		}
	},

	reset: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const mode = String(form.get('seedMode') ?? 'keep');
		const seed: SeedChoice =
			mode === 'random' ? { mode: 'random' } : mode === 'set' ? { mode: 'set', seed: String(form.get('seed') ?? '').trim() } : { mode: 'keep' };
		if (seed.mode === 'set' && !seed.seed) return fail(400, { ok: false, message: 'Enter the seed to use.' });
		try {
			await resetWorld(instance, { snapshot: await decideSnapshot(instance, form.get('snapshot'), { moves: true }), seed });
			return { ok: true, message: `Resetting the world. ${STARTED}` };
		} catch (err) {
			return refused(err);
		}
	}
};
