import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { regionOverview } from '#lib/server/chunkmap.js';
import { chunkMapFolder } from '#lib/server/world.js';

/**
 * The chunk map's overview (World > Restore chunks): every region file of a
 * dimension, live or in a snapshot, with the chunks it holds.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	const folder = await chunkMapFolder(instance, url.searchParams.get('source') ?? 'live', url.searchParams.get('dimension') ?? '');
	if (!folder) return Response.json({ regions: [] });
	return Response.json({ regions: await regionOverview(folder.base) });
};
