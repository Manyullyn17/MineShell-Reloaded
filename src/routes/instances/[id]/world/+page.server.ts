import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { InstanceError, requireInstance, summarise } from '$lib/server/instances';
import { readProperties } from '$lib/server/properties';
import { serverWorldName } from '$lib/server/packworld';
import {
	decideSnapshot,
	deleteSnapshot,
	getSnapshot,
	listSnapshots,
	setSnapshotPinned,
	snapshotPrompt,
	SnapshotChoiceNeeded,
	worldFolders
} from '$lib/server/snapshots';
import { resetWorld, restoreSnapshot, snapshotNow, type SeedChoice } from '$lib/server/world';
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
} from '$lib/server/chunky';

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	const { values } = await readProperties(instance.path);
	const running = (await summarise(instance)).running;
	return {
		running,
		chunky: (await hasChunky(instance.path)) ? await chunkyData(instance, running) : null,
		levelName: await serverWorldName(instance.path),
		worlds: await worldFolders(instance.path),
		seed: values['level-seed'] ?? '',
		snapshotPrompt: await snapshotPrompt(instance.path),
		snapshots: await listSnapshots(instance.path),
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

function chunkyRefused(err: unknown) {
	if (err instanceof ChunkyError) return fail(400, { ok: false, message: err.message });
	throw err;
}

const worldOf = (form: FormData) => String(form.get('world') ?? '') || null;

function refused(err: unknown) {
	if (err instanceof InstanceError || err instanceof SnapshotChoiceNeeded) return fail(400, { ok: false, message: err.message });
	throw err;
}

const STARTED = 'Follow it in Tasks; the server stays stopped until it finishes.';

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
		try {
			await restoreSnapshot(instance, String(form.get('id') ?? ''), {
				snapshot: await decideSnapshot(instance.path, form.get('snapshot'))
			});
			return { ok: true, message: `Restoring the snapshot. ${STARTED}` };
		} catch (err) {
			return refused(err);
		}
	},

	pinSnapshot: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const pinned = form.get('pinned') === 'true';
		try {
			await setSnapshotPinned(instance.path, String(form.get('id') ?? ''), pinned);
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Could not change that snapshot.' });
		}
		return { ok: true, message: pinned ? 'Pinned: kept until you unpin it.' : 'Unpinned: it counts towards the limit again.' };
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

	reset: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const mode = String(form.get('seedMode') ?? 'keep');
		const seed: SeedChoice =
			mode === 'random' ? { mode: 'random' } : mode === 'set' ? { mode: 'set', seed: String(form.get('seed') ?? '').trim() } : { mode: 'keep' };
		if (seed.mode === 'set' && !seed.seed) return fail(400, { ok: false, message: 'Enter the seed to use.' });
		try {
			await resetWorld(instance, { snapshot: await decideSnapshot(instance.path, form.get('snapshot')), seed });
			return { ok: true, message: `Resetting the world. ${STARTED}` };
		} catch (err) {
			return refused(err);
		}
	}
};
