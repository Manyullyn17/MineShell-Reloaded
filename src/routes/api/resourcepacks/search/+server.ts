import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { PACK_SOURCES, searchResourcePacks, type PackSource } from '#lib/server/resourcepacks.js';

/** Resource packs for a Minecraft version (Mods > Resource pack): `?source=&term=&mc=&page=`. */
export const GET: RequestHandler = async ({ url }) => {
	const source = url.searchParams.get('source') as PackSource;
	if (!PACK_SOURCES.includes(source)) error(400, 'Unknown catalog.');
	const page = Number(url.searchParams.get('page') ?? 1);
	try {
		return Response.json(
			await searchResourcePacks(source, url.searchParams.get('term') ?? '', url.searchParams.get('mc') ?? '', Number.isInteger(page) && page > 0 ? page : 1, url.searchParams.has('fresh'))
		);
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Search failed.');
	}
};
