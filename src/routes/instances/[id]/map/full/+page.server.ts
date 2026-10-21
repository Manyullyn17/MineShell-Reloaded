import type { PageServerLoad } from './$types';
import { requireInstance } from '#lib/server/instances.js';
import { mapFrames } from '#lib/server/mapframe.js';

/** The Map tab's map on a page of its own ("Open full screen"): `?map=live` for a map mod's, else the rendered one. */
export const load: PageServerLoad = async ({ params, url, cookies, locals }) => {
	const instance = requireInstance(params.id);
	const frames = mapFrames(instance.id, cookies, locals);
	return { name: instance.name, src: url.searchParams.get('map') === 'live' ? frames.live : frames.view };
};
