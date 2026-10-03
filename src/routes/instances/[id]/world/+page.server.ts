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
	snapshotPrompt,
	SnapshotChoiceNeeded,
	worldFolders
} from '$lib/server/snapshots';
import { resetWorld, restoreSnapshot, snapshotNow, type SeedChoice } from '$lib/server/world';

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	const { values } = await readProperties(instance.path);
	return {
		running: (await summarise(instance)).running,
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

function refused(err: unknown) {
	if (err instanceof InstanceError || err instanceof SnapshotChoiceNeeded) return fail(400, { ok: false, message: err.message });
	throw err;
}

const STARTED = 'Follow it in Tasks; the server stays stopped until it finishes.';

export const actions: Actions = {
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
