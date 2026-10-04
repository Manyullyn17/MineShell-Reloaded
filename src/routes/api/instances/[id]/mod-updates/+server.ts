import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { checkModUpdates } from '#lib/server/modupdates.js';

/** Which mods have a newer version; fetched separately, since a big pack takes a while to check. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	try {
		return json(await checkModUpdates(instance));
	} catch (err) {
		return json({ message: err instanceof Error ? err.message : 'Checking for updates failed.' }, { status: 502 });
	}
};
