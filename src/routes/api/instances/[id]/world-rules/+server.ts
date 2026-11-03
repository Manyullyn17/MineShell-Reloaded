import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance, InstanceError } from '#lib/server/instances.js';
import { hasBorder, readWorldRules } from '#lib/server/worldrules.js';

/** A world's game rules, spawn and border, for World > Game rules (worldrules.ts). */
export const GET: RequestHandler = async ({ params, url }) => {
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	try {
		const rules = await readWorldRules(instance, url.searchParams.get('world') ?? '');
		return Response.json({ ...rules, borderSupported: hasBorder(instance.minecraftVersion) });
	} catch (err) {
		if (err instanceof InstanceError) error(400, err.message);
		throw err;
	}
};
