import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance, InstanceError } from '#lib/server/instances.js';
import { planPackChange, prepareUploadedPack } from '#lib/server/packchange.js';

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

/**
 * Preview of moving to an uploaded pack file (.mrpack or CurseForge zip), sent
 * as the raw body. The file is kept for the apply, under the plan's versionId.
 * A CurseForge zip lists its mods by id, so each is looked up here: a big pack
 * takes a while.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	const buffer = Buffer.from(await request.arrayBuffer());
	if (!buffer.length) error(400, 'Choose a .mrpack or CurseForge pack zip.');

	try {
		const versionId = await prepareUploadedPack(instance, buffer);
		return Response.json({ plan: await planPackChange(instance, versionId) });
	} catch (err) {
		error(400, err instanceof Error ? err.message : 'Could not read that pack file.');
	}
};
