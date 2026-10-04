import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { previewProviderPack } from '#lib/server/packs/preview.js';

/**
 * The mods a pack version installs, with client-only ones marked, for the
 * install form. Slow for a Modrinth pack (the .mrpack is downloaded), which
 * the install that follows then reuses.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const source = url.searchParams.get('source') ?? 'modrinth';
	const projectId = url.searchParams.get('id');
	const versionId = url.searchParams.get('versionId');
	if (!projectId || !versionId) error(400, 'A pack and a version are required.');
	try {
		return json({ preview: await previewProviderPack(source, projectId, versionId) });
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Could not read that pack version.');
	}
};
