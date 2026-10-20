import type { Actions, PageServerLoad } from './$types';
import { cancelTask, getTask, listTasks } from '#lib/server/tasks.js';
import { error, fail } from '@sveltejs/kit';
import { NO_ACCESS_REASON, seesTask } from '#lib/server/access.js';
import { mayCancelTask } from '#lib/shared/access.js';
import { withoutAllowed } from '#lib/server/downloadaccess.js';
import { serviceStates } from '#lib/server/outbound.js';

export const load: PageServerLoad = async ({ locals }) => ({
	tasks: listTasks().filter(seesTask(locals.access)).map(withoutAllowed),
	// Names, times and a short reason only (outbound.ts): nothing an account should not see.
	services: serviceStates()
});

export const actions: Actions = {
	cancel: async ({ request, locals }) => {
		const id = String((await request.formData()).get('id') ?? '');
		// A server's task: its admins; anything else (a Java download, an update, an unknown id): global admins.
		if (!mayCancelTask(locals.access, getTask(id) ?? { instanceId: null })) error(403, NO_ACCESS_REASON);
		const outcome = cancelTask(id);
		if (!outcome) return fail(400, { ok: false, message: 'That task cannot be cancelled, or it has already finished.' });
		return { ok: true, message: `Cancelling. ${outcome}` };
	}
};
