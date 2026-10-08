import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance, InstanceError } from '#lib/server/instances.js';
import { planMigration } from '#lib/server/migrate.js';
import { LOADERS, type ModloaderId } from '#lib/server/modloaders.js';

/**
 * Preview of moving the server to another Minecraft version and loader:
 * what happens to every mod. Read-only, but every mod is looked up on its
 * platform, so it takes a moment; kept for the apply that usually follows.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	const minecraft = url.searchParams.get('mc')?.trim() ?? '';
	const loader = url.searchParams.get('loader') ?? '';
	if (!minecraft || !(loader in LOADERS)) error(400, 'Pick a Minecraft version and a loader.');

	try {
		const plan = await planMigration(instance, {
			minecraft,
			loader: loader as ModloaderId,
			loaderVersion: url.searchParams.get('loaderVersion')?.trim() || null
		});
		return Response.json({ plan });
	} catch (err) {
		if (err instanceof InstanceError) error(400, err.message);
		error(502, err instanceof Error ? err.message : 'Could not work out the move.');
	}
};
