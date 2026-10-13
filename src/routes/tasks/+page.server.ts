import type { Actions, PageServerLoad } from './$types';
import { cancelTask, getTask, listTasks } from '#lib/server/tasks.js';
import { requireAccess, requireGlobalAdmin } from '#lib/server/access.js';

export const load: PageServerLoad = async () => ({ tasks: listTasks() });

export const actions: Actions = {
	cancel: async ({ request, locals }) => {
		const id = String((await request.formData()).get('id') ?? '');
		// A server's task: its admins; anything else (a Java download, an update): global admins.
		const task = getTask(id);
		if (task?.instanceId) requireAccess(locals, task.instanceId, 'admin');
		else requireGlobalAdmin(locals);
		cancelTask(id);
		return { ok: true, message: 'Cancelling after the current download finishes.' };
	}
};
