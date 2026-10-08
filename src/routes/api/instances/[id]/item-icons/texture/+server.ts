import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { iconTexture } from '#lib/server/itemicons.js';

/** One texture out of the server's jars (Minecraft's own only after the EULA answer), by ?ref=ns:path. */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	const png = await iconTexture(instance, url.searchParams.get('ref') ?? '');
	if (!png) error(404, 'No such texture.');
	return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' } });
};
