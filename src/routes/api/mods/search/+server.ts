import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getModProvider } from '#lib/server/mods/index.js';

export const GET: RequestHandler = async ({ url }) => {
	const source = url.searchParams.get('source') ?? 'modrinth';
	try {
		const provider = getModProvider(source);
		const hits = await provider.search({
			term: url.searchParams.get('term') ?? '',
			minecraftVersion: url.searchParams.get('mc') || undefined,
			loaders: url.searchParams.getAll('loader'),
			categories: url.searchParams.getAll('category'),
			projectTypes: url.searchParams.getAll('type') as ('mod' | 'datapack')[],
			kind: 'mod',
			page: Number(url.searchParams.get('page') ?? 1),
			limit: 20
		});
		return Response.json({ hits });
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Search failed.');
	}
};
