import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { InstanceError, requireInstance, summarise } from '#lib/server/instances.js';
import { BACKUP_MOD_FOLDERS, recentDiskBreakdown } from '#lib/server/diskusage.js';
import { startServerExport } from '#lib/server/serverbundle.js';

/** What each choice adds, from the Files tab's disk breakdown (measured a moment ago, or now). */
async function sizes(instance: ReturnType<typeof requireInstance>) {
	const { groups } = await recentDiskBreakdown(instance);
	const group = (id: string) => groups.find((g) => g.id === id);
	const sum = (items: { bytes: number }[] | undefined) => (items ?? []).reduce((n, i) => n + i.bytes, 0);
	return {
		worlds: (group('world')?.bytes ?? 0) + (group('worlds')?.bytes ?? 0),
		snapshots: sum(group('mineshell')?.items.filter((i) => i.path.startsWith('.mineshell/snapshots'))),
		logs: group('logs')?.bytes ?? 0,
		mapTiles: sum(group('map')?.items.filter((i) => !i.outside)),
		modBackups: sum(group('other')?.items.filter((i) => i.path in BACKUP_MOD_FOLDERS)),
		mods: group('mods')?.bytes ?? 0
	};
}

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	return { sizes: sizes(instance), running: (await summarise(instance)).running };
};

export const actions: Actions = {
	export: async ({ params, request }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			const taskId = await startServerExport(instance, {
				worlds: form.get('worlds') === 'on',
				snapshots: form.get('snapshots') === 'on',
				logs: form.get('logs') === 'on',
				mapTiles: form.get('mapTiles') === 'on',
				modBackups: form.get('modBackups') === 'on'
			});
			return { ok: true, taskId };
		} catch (err) {
			if (err instanceof InstanceError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
	}
};
