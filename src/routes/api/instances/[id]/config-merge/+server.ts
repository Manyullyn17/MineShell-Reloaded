import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { lineDiff, mergeView } from '#lib/server/configmerge.js';

/** One file of a pack change's config merge: its sides, and what each side changed. */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	const view = await mergeView(instance.path, url.searchParams.get('stamp') ?? '', url.searchParams.get('path') ?? '');
	if (!view) error(404, 'That file is not in the merge report.');
	return Response.json({
		...view,
		// Without a base (a file only the user had), the sides are compared with each other.
		mineChanges: view.mine !== null ? lineDiff(view.base ?? view.pack ?? '', view.mine) : null,
		packChanges: view.pack !== null && view.base !== null ? lineDiff(view.base, view.pack) : null
	});
};
