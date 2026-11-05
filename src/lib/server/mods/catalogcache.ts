import { cached, CACHE_TTL, invalidateCachePrefix } from '../cache';
import type { SearchHit, SearchQuery } from './types';

/**
 * Searches and project details from the catalogs, kept 10 minutes. Neither holds anything of
 * one server or account (Add mods marks what is installed in the browser), and version lists
 * stay out: what can be installed is always asked for.
 */

const key = (source: string, rest: string) => `catalog:${source}:${rest}`;
const sorted = (values: readonly string[] | undefined) => [...(values ?? [])].sort().join(',');

/** The same search however it was typed or in whichever order its boxes were ticked. */
export function searchCacheKey(source: string, query: SearchQuery): string {
	const parts = [
		query.kind,
		query.term.trim().toLowerCase(),
		query.minecraftVersion ?? '',
		sorted(query.minecraftVersions),
		sorted(query.loaders),
		sorted(query.categories),
		sorted(query.projectTypes),
		query.page ?? 1,
		query.limit ?? ''
	];
	return key(source, `search:${JSON.stringify(parts)}`);
}

/** `fresh` asks the catalog whatever is kept: the Search button. Nothing found is not kept. */
export function cachedSearch(source: string, query: SearchQuery, search: () => Promise<SearchHit[]>, fresh = false): Promise<SearchHit[]> {
	return cached(searchCacheKey(source, query), CACHE_TTL.DEFAULT, search, { fresh, keep: (hits) => hits.length > 0 });
}

export function cachedDetails<T>(source: string, kind: string, id: string, versionId: string | null, details: () => Promise<T>): Promise<T> {
	return cached(key(source, `details:${JSON.stringify([kind, id, versionId])}`), CACHE_TTL.DEFAULT, details);
}

/** CurseForge answers from its own API or from the mirror, depending on the key. */
export function forgetCurseforgeAnswers(): void {
	invalidateCachePrefix(key('curseforge', ''));
}
