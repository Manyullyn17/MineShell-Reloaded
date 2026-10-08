import fs from 'node:fs/promises';
import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { resolveMapFile } from '#lib/server/worldmap.js';

// Kit would strip the slash the app's relative paths need; the handler adds it instead.
export const trailingSlash = 'ignore';

/**
 * The server's map (BlueMap's web app and tiles), served as BlueMap's own
 * web server would, behind MineShell's login. The app uses relative paths,
 * so its page must be addressed with a trailing slash.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	if (!params.path && !url.pathname.endsWith('/')) redirect(308, `${url.pathname}/${url.search}`);

	const found = await resolveMapFile(instance.id, params.path);
	if (!found) error(404, 'Not part of the map.');
	if ('empty' in found) return new Response(null, { status: 204 });
	const headers: Record<string, string> = {
		'content-type': found.type,
		// Tiles change when the map is updated; the browser checks again rather than keeping stale ones.
		'cache-control': 'no-cache'
	};
	if (found.gzip) headers['content-encoding'] = 'gzip';
	return new Response(new Uint8Array(await fs.readFile(found.file)), { headers });
};
