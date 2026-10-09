import type { LayoutServerLoad } from './$types';
import { recentPlayerCount, summariseAll } from '#lib/server/instances.js';
import { listTasks } from '#lib/server/tasks.js';
import { availableUpdate } from '#lib/server/selfupdate.js';
import { gaveUpAfter } from '#lib/shared/format.js';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (!locals.authenticated) {
		return { railInstances: [], runningTasks: 0, authRequired: locals.authRequired, path: url.pathname };
	}

	const summaries = await summariseAll();
	return {
		authRequired: locals.authRequired,
		path: url.pathname,
		runningTasks: listTasks().filter((t) => t.state === 'running').length,
		updateAvailable: availableUpdate()?.version ?? null,
		railInstances: await Promise.all(
			summaries.map(async (s) => ({
				id: s.instance.id,
				name: s.instance.name,
				iconVersion: s.iconVersion,
				active: s.state.active,
				sub: s.state.sub,
				pinned: s.instance.pinned,
				status: s.instance.status,
				players: s.running ? await recentPlayerCount(s.instance) : null,
				gaveUpAfter: gaveUpAfter(s.state.active, s.state.result, s.instance.crashRestartLimit)
			}))
		)
	};
};
