import type { PageServerLoad } from './$types';
import { requireInstance, summarise } from '#lib/server/instances.js';
import { getMacros } from '#lib/server/macros.js';

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	const summary = await summarise(instance);
	return {
		running: summary.running,
		backlogLines: instance.consoleBacklogLines,
		bufferLines: instance.consoleBufferLines,
		macros: getMacros(instance.id)
	};
};
