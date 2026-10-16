import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { InstanceError, requireInstance, summarise } from '#lib/server/instances.js';
import { serverWorldName } from '#lib/server/packworld.js';
import { listSnapshots, snapshotOfWorld } from '#lib/server/snapshots.js';
import { MAX_RESTORE_CHUNKS, restoreChunks, snapshotDimensions, worldSpawn } from '#lib/server/world.js';
import { listDimensions, type Dimension } from '#lib/server/dimensions.js';
import { compareVersions } from '#lib/server/java.js';

const dimensionOption = (d: Dimension) => ({ key: d.paths[0], label: d.label, overworld: d.overworld });

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	const levelName = await serverWorldName(instance.path);
	// Only snapshots of the active world can give chunks back, and only ones holding a dimension.
	const snapshots = (
		await Promise.all(
			(await listSnapshots(instance.path))
				.filter((s) => snapshotOfWorld(s, levelName))
				.map(async (s) => ({
					id: s.id,
					createdAt: s.createdAt,
					label: s.label,
					note: s.note ?? null,
					partial: !!s.partial,
					/** Only the region files a chunk restore changed: offered, but not picked first. */
					beforeChunkRestore: s.reason === 'world-restore-chunks',
					dimensions: (await snapshotDimensions(instance, s)).map(dimensionOption)
				}))
		)
	).filter((s) => s.dimensions.length);
	return {
		running: (await summarise(instance)).running,
		levelName,
		dimensions: (await listDimensions(instance.path)).map(dimensionOption),
		snapshots,
		spawn: await worldSpawn(instance.path),
		legacy: compareVersions(instance.minecraftVersion, '1.13') < 0,
		maxChunks: MAX_RESTORE_CHUNKS
	};
};

/** "x,z;x,z" -> chunk positions; null when it is not that. */
function parseChunks(text: string): [number, number][] | null {
	if (!text) return [];
	const out: [number, number][] = [];
	for (const pair of text.split(';')) {
		const m = pair.match(/^(-?\d+),(-?\d+)$/);
		if (!m) return null;
		out.push([Number(m[1]), Number(m[2])]);
	}
	return out;
}

export const actions: Actions = {
	restore: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const chunks = parseChunks(String(form.get('chunks') ?? ''));
		if (!chunks) return fail(400, { ok: false, message: 'Those are not chunk positions.' });
		try {
			// Always kept: the snapshot is only the region files that change, moved aside, never a copy of the world.
			await restoreChunks(instance, String(form.get('id') ?? ''), String(form.get('dimension') ?? ''), chunks, { snapshot: true });
			return { ok: true, message: 'Restoring the chunks. Follow it in Tasks; once it is done, Reload map shows the result.' };
		} catch (err) {
			if (err instanceof InstanceError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
	}
};
