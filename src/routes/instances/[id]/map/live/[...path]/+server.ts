import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { liveMapTarget } from '#lib/server/worldmap.js';

// Kit would strip the slash the map apps' relative paths need; the handler adds it instead.
export const trailingSlash = 'ignore';

/** Headers that belong to one connection, not to what is passed on. */
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'cookie', 'authorization']);

/**
 * A map mod's own web server (Dynmap, the BlueMap mod), passed through
 * behind MineShell's login: the mod listens on localhost only, on the port
 * MineShell gave it. Bodies are streamed, so live updates keep flowing.
 */
const pass: RequestHandler = async ({ params, url, request, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
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
	const out = new Headers();
	for (const [name, value] of answer.headers) if (!HOP.has(name.toLowerCase()) && name.toLowerCase() !== 'content-encoding') out.set(name, value);
	return new Response(answer.body, { status: answer.status, headers: out });
};

export const GET = pass;
export const POST = pass;
