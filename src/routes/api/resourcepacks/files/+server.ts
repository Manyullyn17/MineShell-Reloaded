import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { PACK_SOURCES, resourcePackFiles, type PackSource } from '#lib/server/resourcepacks.js';

/** A resource pack's files for a Minecraft version, newest first: `?source=&id=&mc=`. */
export const GET: RequestHandler = async ({ url }) => {
	const source = url.searchParams.get('source') as PackSource;
	const id = url.searchParams.get('id') ?? '';
	if (!PACK_SOURCES.includes(source) || !id) error(400, 'Unknown catalog or pack.');
	try {
		return Response.json({ files: await resourcePackFiles(source, id, url.searchParams.get('mc') ?? '') });
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Could not list the files.');
	}
};
