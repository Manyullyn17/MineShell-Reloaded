import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { skinFile } from '#lib/server/profiles.js';

/** A player's skin by texture id, through MineShell (cached), for the faces on the Players pages. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const bytes = await skinFile(params.texture);
	if (!bytes) error(404, 'No such skin.');
	return new Response(new Uint8Array(bytes), {
		// A texture id never names another image.
		headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=31536000, immutable' }
	});
};
