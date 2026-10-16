import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { checkDatapackUpdates } from '#lib/server/modupdates.js';

/** Which data packs from the mod browser have a newer build; fetched separately, like mod updates. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	try {
		return Response.json(await checkDatapackUpdates(instance));
	} catch (err) {
		return Response.json({ message: err instanceof Error ? err.message : 'Checking for updates failed.' }, { status: 502 });
	}
};
