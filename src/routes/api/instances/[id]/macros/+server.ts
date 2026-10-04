import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { setMacros } from '#lib/server/macros.js';

/** The console's saved commands; the whole list is sent each time, in display order. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	const body = (await request.json().catch(() => ({}))) as { macros?: unknown };
	return json({ macros: setMacros(instance.id, body.macros) });
};
