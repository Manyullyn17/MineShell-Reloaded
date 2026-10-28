import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { modIcon } from '#lib/server/modicons.js';

/**
 * An installed mod's picture for the Mods tab (modicons.ts). The page adds
 * `v` (the mod's version or size), so a changed jar has another address and
 * this one can be kept a day.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	const icon = await modIcon(instance, url.searchParams.get('file') ?? '');
	if (!icon) return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, max-age=3600' } });
	return new Response(new Uint8Array(icon.bytes), {
		headers: { 'Content-Type': icon.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' }
	});
};
