import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { compareVersionPriority, getProvider } from '#lib/server/mods/index.js';

export const GET: RequestHandler = async ({ url }) => {
	const source = url.searchParams.get('source') ?? 'modrinth';
	const id = url.searchParams.get('id');
	if (!id) error(400, 'A project id is required.');

	try {
		const provider = getProvider(source);
		const versions = await provider.listVersions(id, {
			minecraftVersion: url.searchParams.get('mc') || undefined
		});
		versions.sort(compareVersionPriority);
		return Response.json({
			versions: versions.map((v) => ({
				id: v.id,
				name: v.name,
				versionNumber: v.versionNumber,
				channel: v.channel,
				datePublished: v.datePublished,
				gameVersions: v.gameVersions,
				loaders: v.loaders
			}))
		});
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Version lookup failed.');
	}
};
