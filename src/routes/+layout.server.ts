import type { LayoutServerLoad } from './$types';
import { summariseAll } from '#lib/server/instances.js';
import { railInstances } from '#lib/server/rail.js';
import { listTasks } from '#lib/server/tasks.js';
import { availableUpdate } from '#lib/server/selfupdate.js';
import { sees, seesTask } from '#lib/server/access.js';
import { NO_ACCESS } from '#lib/shared/access.js';

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
		railInstances: await railInstances(summaries)
	};
};
