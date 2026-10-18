import type { LayoutServerLoad } from './$types';
import { recentPlayerCount, summariseAll } from '#lib/server/instances.js';
import { listTasks } from '#lib/server/tasks.js';
import { availableUpdate } from '#lib/server/selfupdate.js';
import { sees, seesTask } from '#lib/server/access.js';
import { NO_ACCESS } from '#lib/shared/access.js';
import { gaveUpAfter } from '#lib/shared/format.js';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (!locals.authenticated) {
		return { railInstances: [], runningTasks: 0, finishedTasks: [], authRequired: locals.authRequired, path: url.pathname, access: NO_ACCESS };
	}

	// Only the servers and tasks this account may see; an update only to whoever may install it.
	const summaries = await summariseAll(sees(locals.access));
	const tasks = listTasks().filter(seesTask(locals.access));
	return {
		authRequired: locals.authRequired,
		/** What this account may do (its own permissions), for pages to show only what it can use. The server checks again. */
		access: locals.access,
		path: url.pathname,
		runningTasks: tasks.filter((t) => t.state === 'running').length,
		/** Already finished: the notification center does not announce these (taskwatch.ts). */
		finishedTasks: tasks.filter((t) => t.state !== 'running').map((t) => t.id),
		updateAvailable: locals.access.owner ? (availableUpdate()?.version ?? null) : null,
		railInstances: await Promise.all(
			summaries.map(async (s) => ({
				id: s.instance.id,
				name: s.instance.name,
				iconVersion: s.iconVersion,
				active: s.state.active,
				sub: s.state.sub,
				phase: s.phase,
				pinned: s.instance.pinned,
				status: s.instance.status,
				players: s.running ? await recentPlayerCount(s.instance) : null,
				gaveUpAfter: gaveUpAfter(s.state.active, s.state.result, s.instance.crashRestartLimit)
			}))
		)
	};
};
