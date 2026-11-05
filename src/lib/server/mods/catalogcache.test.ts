import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateCache } from '../cache';
import { setCurseforgeApiKey } from '../curseforge';
import { cachedDetails, cachedSearch, searchCacheKey } from './catalogcache';
import type { SearchHit, SearchQuery } from './types';

const query = (over: Partial<SearchQuery> = {}): SearchQuery => ({ term: 'sodium', kind: 'mod', page: 1, limit: 20, ...over });
const hit = { id: 'a' } as SearchHit;

describe('searchCacheKey', () => {
	it('is the same however the search was typed or ticked', () => {
		const key = searchCacheKey('modrinth', query({ loaders: ['fabric', 'quilt'], categories: ['magic', 'tech'] }));
		expect(searchCacheKey('modrinth', query({ term: '  SoDium ', loaders: ['quilt', 'fabric'], categories: ['tech', 'magic'] }))).toBe(key);
	});

	it('differs by everything that changes the answer', () => {
		const key = searchCacheKey('modrinth', query());
		for (const other of [
			searchCacheKey('curseforge', query()),
			searchCacheKey('modrinth', query({ term: 'iris' })),
			searchCacheKey('modrinth', query({ kind: 'modpack' })),
			searchCacheKey('modrinth', query({ page: 2 })),
			searchCacheKey('modrinth', query({ minecraftVersion: '1.21.1' })),
			searchCacheKey('modrinth', query({ loaders: ['fabric'] })),
			searchCacheKey('modrinth', query({ categories: ['magic'] })),
			searchCacheKey('modrinth', query({ projectTypes: ['datapack'] }))
		]) {
			expect(other).not.toBe(key);
		}
	});

	it('does not run a term and a filter together', () => {
		expect(searchCacheKey('modrinth', query({ term: 'a', loaders: ['b'] }))).not.toBe(searchCacheKey('modrinth', query({ term: 'a,b' })));
	});
});

describe('cachedSearch', () => {
	beforeEach(() => invalidateCache());

	it('asks once for a repeated search, and again for the Search button', async () => {
		const search = vi.fn(async () => [hit]);
		await cachedSearch('modrinth', query(), search);
		await cachedSearch('modrinth', query({ term: 'SODIUM' }), search);
		expect(search).toHaveBeenCalledTimes(1);
		await cachedSearch('modrinth', query(), search, true);
		expect(search).toHaveBeenCalledTimes(2);
	});

	it('keeps no empty answer', async () => {
		const search = vi.fn(async () => [] as SearchHit[]);
		await cachedSearch('modrinth', query(), search);
		await cachedSearch('modrinth', query(), search);
		expect(search).toHaveBeenCalledTimes(2);
	});

	it('forgets CurseForge answers, and only those, when the key goes', async () => {
		const search = vi.fn(async () => [hit]);
		const details = vi.fn(async () => 'text');
		await cachedSearch('curseforge', query(), search);
		await cachedSearch('modrinth', query(), search);
		await cachedDetails('curseforge', 'mod', '1', null, details);
		await setCurseforgeApiKey('');
		await cachedSearch('curseforge', query(), search);
		await cachedSearch('modrinth', query(), search);
		await cachedDetails('curseforge', 'mod', '1', null, details);
		expect(search).toHaveBeenCalledTimes(3);
		expect(details).toHaveBeenCalledTimes(2);
	});
});

describe('cachedDetails', () => {
	beforeEach(() => invalidateCache());

	it('keeps a project and each of its versions apart', async () => {
		const details = vi.fn(async () => 'text');
		await cachedDetails('modrinth', 'mod', '1', null, details);
		await cachedDetails('modrinth', 'mod', '1', 'v1', details);
		await cachedDetails('modrinth', 'mod', '1', null, details);
		expect(details).toHaveBeenCalledTimes(2);
	});
});
