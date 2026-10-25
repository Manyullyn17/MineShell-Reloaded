import type { PageServerLoad } from './$types';
import { requireInstance } from '#lib/server/instances.js';
import { modListEntries } from '#lib/server/modlist.js';

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	// Reading every jar's metadata takes a moment on a big pack; the page shows first.
	return { mods: modListEntries(instance) };
};
