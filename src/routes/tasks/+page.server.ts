import type { Actions, PageServerLoad } from './$types';
import { cancelTask, listTasks } from '#lib/server/tasks.js';

export const load: PageServerLoad = async () => ({ tasks: listTasks() });

export const actions: Actions = {
	cancel: async ({ request }) => {
		cancelTask(String((await request.formData()).get('id') ?? ''));
		return { ok: true, message: 'Cancelling after the current download finishes.' };
	}
};
