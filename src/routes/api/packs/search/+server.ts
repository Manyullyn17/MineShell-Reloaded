import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cachedSearch } from '#lib/server/mods/catalogcache.js';
import { getProvider } from '#lib/server/mods/index.js';
import { withProjectById } from '#lib/server/mods/projectid.js';

export const GET: RequestHandler = async ({ url }) => {
	const source = url.searchParams.get('source') ?? 'modrinth';
	try {
		const mcVersions = url.searchParams.getAll('mc');
		const provider = getProvider(source);
		const query = {
			term: url.searchParams.get('term') ?? '',
			minecraftVersion: mcVersions[0],
			minecraftVersions: mcVersions.length ? mcVersions : undefined,
			loaders: url.searchParams.getAll('loader'),
			categories: url.searchParams.getAll('category'),
			kind: 'modpack' as const,
			page: Number(url.searchParams.get('page') ?? 1),
			limit: 20
		};
		// A pack's project id finds it where the catalog's search does not (projectid.ts).
		const search = () =>
			withProjectById({ source, term: query.term, page: query.page, kind: 'modpack', lookup: (id) => provider.getProject(id), search: () => provider.search(query) });
		const hits = await cachedSearch(source, query, search, url.searchParams.has('fresh'));
		return Response.json({ hits });
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Search failed.');
	}
};
