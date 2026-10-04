import type { LayoutServerLoad } from './$types';
import { summariseAll } from '#lib/server/instances.js';
import { listTasks } from '#lib/server/tasks.js';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (!locals.authenticated) {
		return { railInstances: [], runningTasks: 0, authRequired: locals.authRequired, path: url.pathname };
	}

	const summaries = await summariseAll();
	return {
		authRequired: locals.authRequired,
		path: url.pathname,
		runningTasks: listTasks().filter((t) => t.state === 'running').length,
		railInstances: summaries.map((s) => ({
			id: s.instance.id,
			name: s.instance.name,
			active: s.state.active,
			sub: s.state.sub,
			pinned: s.instance.pinned,
			status: s.instance.status
		}))
	};
};
