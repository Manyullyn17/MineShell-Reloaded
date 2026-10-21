import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { liveMapTarget } from '#lib/server/worldmap.js';
import { MAP_HEADERS, mapPreflight, mapRequest, withShim } from '#lib/server/mapframe.js';

// Kit would strip the slash the map apps' relative paths need; the handler adds it instead.
export const trailingSlash = 'ignore';

/** Headers that belong to one connection, not to what is passed on. */
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'cookie', 'authorization', 'origin', 'referer']);
/** Nor may the map set cookies, or headers of its own in place of the sandbox's. */
const DROPPED = new Set([...HOP, 'content-encoding', 'set-cookie', ...Object.keys(MAP_HEADERS)]);

/**
 * A map mod's own web server (Dynmap, the BlueMap mod), passed through,
 * sandboxed under the Map tab's token (mapframe.ts): the mod listens on
 * localhost only, on the port MineShell gave it. Bodies are streamed, so live
 * updates keep flowing; its pages get the shim first.
 */
const pass: RequestHandler = async ({ params, url, request }) => {
	// POSTs are the map's own (Dynmap's web chat), which speaks in the game.
	const instance = mapRequest(params.token, request.method === 'POST' ? 'map.render' : 'view');
	if (!params.path && !url.pathname.endsWith('/')) redirect(308, `${url.pathname}/${url.search}`);
	const target = await liveMapTarget(instance, params.path, url.search);
	if (!target) error(404, 'This server has no map mod.');

	const headers = new Headers();
	for (const [name, value] of request.headers) if (!HOP.has(name.toLowerCase())) headers.set(name, value);
	let answer: Response;
	try {
		answer = await fetch(target, {
			method: request.method,
			headers,
			body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
			redirect: 'manual'
		});
	} catch {
		error(502, 'The map is not answering: it runs while the server runs (and starts a little after it).');
	}
	const out = new Headers(MAP_HEADERS);
	for (const [name, value] of answer.headers) if (!DROPPED.has(name.toLowerCase())) out.set(name, value);
	if (out.get('content-type')?.startsWith('text/html')) return new Response(withShim(await answer.text()), { status: answer.status, headers: out });
	return new Response(answer.body, { status: answer.status, headers: out });
};

export const GET = pass;
export const POST = pass;
export const OPTIONS: RequestHandler = ({ params, request }) => {
	mapRequest(params.token, 'view');
	return mapPreflight(request);
};
