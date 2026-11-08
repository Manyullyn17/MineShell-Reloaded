import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance, InstanceError } from '#lib/server/instances.js';
import { playerState } from '#lib/server/playercommands.js';

/** An online player's game mode, dimension, position and spawn point, for the players page's In game (playercommands.ts). */
export const GET: RequestHandler = async ({ params, url }) => {
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	try {
		return json(await playerState(instance, url.searchParams.get('name') ?? ''));
	} catch (err) {
		if (err instanceof InstanceError) error(400, err.message);
		throw err;
	}
};
