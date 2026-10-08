import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { itemChoices } from '#lib/server/itemicons.js';

/** Every item the server knows (vanilla and its mods), with names, for the player editor's picker. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	return Response.json({ items: await itemChoices(instance) });
};
