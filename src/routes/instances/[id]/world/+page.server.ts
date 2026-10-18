import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from '@sveltejs/kit';
import { requireAccess } from '#lib/server/access.js';
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
	worldSeed,
	WorldVersionError,
	type SeedChoice
} from '#lib/server/world.js';
import { listWorlds, newerWorldWarning, otherLoaderWarning, snapshotWorldFolder, withSizes } from '#lib/server/worlds.js';
import { webRoot } from '#lib/server/worldmap.js';
import { listDimensions, type Dimension } from '#lib/server/dimensions.js';
import { getTask } from '#lib/server/tasks.js';
import {
	cancelPregen,
	chunkyLanguage,
	chunkyStatus,
	ChunkyError,
	confirmPregen,
	continuePregen,
	hasChunky,
	pausedForPlayers,
	pausePregen,
	pausesForPlayers,
	savedTasks,
	setPausesForPlayers,
	startPregen
} from '#lib/server/chunky.js';

export const load: PageServerLoad = async ({ params }) => {
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
		// Dimensions travel to the page as the first of their folders, which is how actions name them.
		dimensions: (await listDimensions(instance.path)).map(dimensionOption),
		pruneAnalysis: pruneAnalysisSummary(instance.id),
		pruneAnalysing: analysingNow(instance.id),
		snapshots: await Promise.all(
			snapshots.map(async (s) => {
				// Only one of the world the server uses can be restored (snapshotOfWorld).
				const ofThisWorld = snapshotOfWorld(s, levelName);
				return {
					...s,
					ofThisWorld,
					worldFolder: ofThisWorld ? levelName : snapshotWorldFolder(s, folders),
					dimensions: ofThisWorld ? (await snapshotDimensions(instance, s)).map(dimensionOption) : []
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
			modloaderVersion: instance.modloaderVersion
		}
	};
};

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
		pausedForPlayers: pausedForPlayers(instance.id)
	};
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
				shape: String(form.get('shape')) === 'circle' ? 'circle' : 'square',
				centerX: Number(form.get('centerX') || 0),
				centerZ: Number(form.get('centerZ') || 0),
				radius: Number(form.get('radius'))
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

	snapshot: async ({ params }) => {
		try {
			await snapshotNow(requireInstance(params.id));
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
			// Its progress shows by the button (PruneMap, from the page's data), not as a message.
			await analysePrunable(instance, String(form.get('dimension') ?? ''));
			return { ok: true };
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
