import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getLoader, listReleaseVersions } from '#lib/server/modloaders.js';

/** Powers the version pickers on the new-server form. */
export const GET: RequestHandler = async ({ url }) => {
	const loaderId = url.searchParams.get('loader') ?? 'vanilla';
	const minecraft = url.searchParams.get('mc') ?? '';

	try {
		if (url.searchParams.get('kind') === 'game') {
			const loader = getLoader(loaderId);
			const versions = await loader.listGameVersions();
			return json({ versions });
		}
		if (!minecraft) return json({ versions: [] });
		const loader = getLoader(loaderId);
		const versions = await loader.listLoaderVersions(minecraft);
		return json({ versions });
	} catch (err) {
		// The upstream metadata servers go down occasionally; the form falls back
		// to a free-text field rather than blocking the user.
		error(502, err instanceof Error ? err.message : 'Version lookup failed.');
	}
};

export const fallback: RequestHandler = async () => {
	const versions = await listReleaseVersions();
	return json({ versions });
};
