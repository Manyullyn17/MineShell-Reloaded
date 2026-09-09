import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireInstance, restart, start, stop, summarise } from '$lib/server/instances';

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	const summary = await summarise(instance);
	return {
		running: summary.running,
		backlogLines: instance.consoleBacklogLines,
		bufferLines: instance.consoleBufferLines
	};
};

export const actions: Actions = {
	power: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const verb = String((await request.formData()).get('verb') ?? '');
		const result =
			verb === 'start'
				? await start(instance)
				: verb === 'stop'
					? await stop(instance)
					: verb === 'restart'
						? await restart(instance)
						: { ok: false, message: `Unknown action "${verb}".` };
		return result.ok ? result : fail(400, result);
	}
};
