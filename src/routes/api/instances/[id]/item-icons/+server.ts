import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { compareVersions } from '#lib/server/java.js';
import { iconsFor } from '#lib/server/itemicons.js';

/**
 * Icons for the player editor: what to draw for each item (layers or a
 * block's faces) - the browser draws it from the textures endpoint. Damage
 * only counts before 1.13, where it can be a variant.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	const body = (await request.json().catch(() => null)) as { items?: { id?: unknown; damage?: unknown }[] } | null;
	const legacy = compareVersions(instance.minecraftVersion, '1.13') < 0;
	const items = (body?.items ?? [])
		.filter((i) => typeof i.id === 'string')
		.map((i) => ({ id: i.id as string, damage: legacy && typeof i.damage === 'number' ? i.damage : null }));
	return Response.json(await iconsFor(instance, items));
};
