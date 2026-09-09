import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProvider } from '$lib/server/mods';

export const GET: RequestHandler = async ({ url }) => {
	const source = url.searchParams.get('source') ?? 'modrinth';
	try {
		const provider = getProvider(source);
		const hits = await provider.search({
			term: url.searchParams.get('term') ?? '',
			minecraftVersion: url.searchParams.get('mc') || undefined,
			loaders: url.searchParams.getAll('loader'),
			categories: url.searchParams.getAll('category'),
			kind: 'modpack',
			page: Number(url.searchParams.get('page') ?? 1),
			limit: 20
		});
		return json({ hits });
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Search failed.');
	}
};
