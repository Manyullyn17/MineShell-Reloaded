import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance, InstanceError } from '#lib/server/instances.js';
import { planPackChange } from '#lib/server/packchange.js';

/**
 * Preview of moving the instance's pack to another version. Read-only, but
 * slow for CurseForge packs: the target's overrides.zip is downloaded here and
 * kept for the apply that usually follows.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	const versionId = url.searchParams.get('versionId');
	if (!versionId) error(400, 'A pack version is required.');

	try {
		return Response.json({ plan: await planPackChange(instance, versionId) });
	} catch (err) {
		if (err instanceof InstanceError) error(400, err.message);
		error(502, err instanceof Error ? err.message : 'Could not look up that pack version.');
	}
};
