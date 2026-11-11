import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cachedSearch } from '#lib/server/mods/catalogcache.js';
import { getModProvider } from '#lib/server/mods/index.js';
import { withProjectById } from '#lib/server/mods/projectid.js';

export const GET: RequestHandler = async ({ url }) => {
	const source = url.searchParams.get('source') ?? 'modrinth';
	try {
		const provider = getModProvider(source);
		const query = {
			term: url.searchParams.get('term') ?? '',
			minecraftVersion: url.searchParams.get('mc') || undefined,
			loaders: url.searchParams.getAll('loader'),
			categories: url.searchParams.getAll('category'),
			projectTypes: url.searchParams.getAll('type') as ('mod' | 'datapack')[],
			kind: 'mod' as const,
			page: Number(url.searchParams.get('page') ?? 1),
			limit: 20
		};
		// A mod's or data pack's project id finds it where the catalog's search does not (projectid.ts).
		const search = () =>
			withProjectById({ source, term: query.term, page: query.page, kind: 'mod', lookup: (id) => provider.getProject(id), search: () => provider.search(query) });
		const hits = await cachedSearch(source, query, search, url.searchParams.has('fresh'));
		return Response.json({ hits });
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Search failed.');
	}
};
