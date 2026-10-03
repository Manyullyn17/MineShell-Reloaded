import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance, InstanceError } from '$lib/server/instances';
import { listModVersions } from '$lib/server/modupdates';

/** The versions one installed mod can switch to, older ones included. */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	try {
		return json(await listModVersions(instance, url.searchParams.get('fileName') ?? ''));
	} catch (err) {
		const status = err instanceof InstanceError ? 400 : 502;
		return json({ message: err instanceof Error ? err.message : 'Looking up versions failed.' }, { status });
	}
};
