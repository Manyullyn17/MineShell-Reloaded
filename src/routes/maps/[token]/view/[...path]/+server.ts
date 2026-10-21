import fs from 'node:fs/promises';
import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveMapFile } from '#lib/server/worldmap.js';
import { MAP_HEADERS, mapRequest, withShim } from '#lib/server/mapframe.js';

// Kit would strip the slash the app's relative paths need; the handler adds it instead.
export const trailingSlash = 'ignore';

/**
 * The server's map (BlueMap's web app and tiles), served as BlueMap's own
 * web server would, sandboxed under the Map tab's token (mapframe.ts). The
 * app uses relative paths, so its page must be addressed with a trailing slash.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const instance = mapRequest(params.token, 'view');
	if (!params.path && !url.pathname.endsWith('/')) redirect(308, `${url.pathname}/${url.search}`);

	const found = await resolveMapFile(instance.id, params.path);
	if (!found) error(404, 'Not part of the map.');
	if ('empty' in found) return new Response(null, { status: 204, headers: MAP_HEADERS });
	const headers: Record<string, string> = {
		...MAP_HEADERS,
		'content-type': found.type,
		// Tiles change when the map is updated; the browser checks again rather than keeping stale ones.
		'cache-control': 'no-cache'
	};
	if (found.gzip) headers['content-encoding'] = 'gzip';
	if (found.type.startsWith('text/html') && !found.gzip) return new Response(withShim(await fs.readFile(found.file, 'utf8')), { headers });
	return new Response(new Uint8Array(await fs.readFile(found.file)), { headers });
};
