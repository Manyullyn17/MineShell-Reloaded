import { fetchJson } from '../download';
import { cached, CACHE_TTL } from '../cache';
import type { FilterGroup, ModProvider, ProjectVersion, SearchHit, SearchQuery, SourceId } from './types';

/**
 * modpacks.ch is the FTB App's public backend: it mirrors CurseForge project
 * metadata and serves FTB's own packs, so MineShell can browse both without a
 * CurseForge API key.
 *
 * This file was rewritten against modpacks.ch's actual OpenAPI spec (kept in
 * project knowledge), not the original design doc's incomplete notes - that
 * incomplete picture is what produced the first version of this file, which
 * never actually worked. Confirmed straight from the spec:
 *
 *   - Every arity from 1 to 5 path segments (`/search/{a}`, `/search/{a}/{b}`,
 *     ... up to `/search/{a}/{b}/{c}/{sort}/{page}`) is its OWN registered
 *     route with every param required. There is no "optional" trailing
 *     segment - so the old code's habit of always padding to 5 segments with
 *     empty strings for anything unselected didn't hit a route at all. That's
 *     the confirmed `search///featured/1` failure. Fixed by only ever
 *     emitting as many segments as there are real values.
 *   - CurseForge's `/search/...` and `/browse/...` families are documented
 *     completely identically (same description, same response schema) - CF
 *     browsing has no separate free-text mode via this API. FTB's `/search`
 *     is genuinely different from its `/browse`: `/search` takes a `term`
 *     query param and returns bare id *lists* (`packs`, and, usefully,
 *     `curseforge` - the same search covers both catalogs at once); `/browse`
 *     takes filters and returns full pack cards directly, no per-id detail
 *     fetch needed.
 *   - The single-item detail/version endpoints for CurseForge are
 *     `/public/curseforge/{id}` and `/public/curseforge/{id}/{versionid}` -
 *     NOT `/public/curseforge/modpack/{id}`, which is what the old code
 *     called and which doesn't exist in the spec at all.
 *   - Tag list responses are `{ status, tags: [...], refreshed }`, not a bare
 *     array - the old code parsed them as a bare array, which would have
 *     silently produced zero categories even if the URL were otherwise fine.
 *
 * Still an inference, not a live-confirmed fact: once you combine 2-3 of
 * category/loader/version with an explicit sort *and* page in the same call,
 * whether the server tells them apart by content (a numeric id vs a known
 * loader name vs a version string) or expects a fixed order. The 4th and 5th
 * segments are unambiguous once present ("sort", enum new/featured/updated/
 * popular; "page", a number) - it's only the first three that are documented
 * identically vague ("category, loader, or game version") for every
 * position, which reads as content-sniffed rather than fixed-order, but
 * that's a reading, not a confirmed fact. A plain filterless browse - the
 * originally-reported failure - only ever needs 1-2 segments and doesn't
 * depend on this either way. Worth a real request before fully trusting a
 * combined filter+sort+page call.
 */

const API = 'https://api.modpacks.ch';

type ArtEntry = { url: string; type: string };
type Author = { name: string };
type Tag = { id: number; name: string };
type Target = { name: string; type: string; version: string };

/** The lightweight card shape returned directly by /browse and /search. */
type BrowseCard = {
	id: number | string;
	name: string;
	synopsis?: string;
	authors?: Author[];
	art?: ArtEntry[];
	installs?: number;
	targets?: Target[] | null;
};

type SearchIds = { packs?: number[]; curseforge?: number[]; total?: number };

/** The richer shape returned by a single-item detail fetch. */
type PackDetail = {
	id: number | string;
	name: string;
	slug?: string;
	synopsis?: string;
	description?: string;
	authors?: Author[];
	art?: ArtEntry[];
	versions?: { id: number; name: string; type: string; updated: number; targets?: Target[] }[];
	installs?: number;
};

type VersionDetail = {
	id: number;
	name: string;
	type: string;
	updated: number;
	targets?: Target[];
	changelog?: string;
	files?: { name: string; url: string; sha1?: string; size?: number; clientonly?: boolean }[];
};

function artUrl(entity: { art?: ArtEntry[] }): string | null {
	const square = entity.art?.find((a) => a.type === 'square') ?? entity.art?.[0];
	return square?.url ?? null;
}

function targetsToLoaders(targets: Target[] | null | undefined): string[] {
	return (targets ?? []).filter((t) => t.type === 'modloader').map((t) => t.name.toLowerCase());
}

function targetsToGameVersions(targets: Target[] | null | undefined): string[] {
	return (targets ?? []).filter((t) => t.type === 'game').map((t) => t.version);
}

function projectUrl(source: SourceId, id: number | string): string | null {
	return source === 'ftb' ? `https://feed-the-beast.com/modpacks/${id}` : null;
}

function cardToHit(source: SourceId, card: BrowseCard): SearchHit {
	return {
		source,
		id: String(card.id),
		slug: String(card.id),
		name: card.name,
		author: card.authors?.[0]?.name ?? null,
		summary: card.synopsis?.trim() || null,
		iconUrl: artUrl(card),
		downloads: card.installs ?? null,
		projectUrl: projectUrl(source, card.id),
		loaders: targetsToLoaders(card.targets),
		gameVersions: targetsToGameVersions(card.targets)
	};
}

function detailToHit(source: SourceId, pack: PackDetail): SearchHit {
	const targets = pack.versions?.[0]?.targets;
	return {
		source,
		id: String(pack.id),
		slug: pack.slug ?? String(pack.id),
		name: pack.name,
		author: pack.authors?.[0]?.name ?? null,
		summary: pack.synopsis?.trim() || pack.description?.slice(0, 240) || null,
		iconUrl: artUrl(pack),
		downloads: pack.installs ?? null,
		projectUrl: projectUrl(source, pack.id),
		loaders: targetsToLoaders(targets),
		gameVersions: targetsToGameVersions(targets)
	};
}

function detailToVersion(projectId: string, version: VersionDetail): ProjectVersion {
	// A server install has no use for client-only assets (resource packs,
	// client-side-only mods) bundled into the same pack version.
	const files = (version.files ?? []).filter((f) => !f.clientonly);
	return {
		id: String(version.id),
		projectId,
		name: version.name,
		versionNumber: version.name,
		channel: version.type ?? 'release',
		datePublished: version.updated ? new Date(version.updated * 1000).toISOString() : null,
		gameVersions: targetsToGameVersions(version.targets),
		loaders: targetsToLoaders(version.targets),
		changelog: version.changelog?.trim() || null,
		files: files.map((f) => ({
			filename: f.name,
			url: f.url,
			primary: true,
			size: f.size ?? null,
			hash: f.sha1 ? { algo: 'sha1' as const, value: f.sha1 } : null
		})),
		dependencies: []
	};
}

/**
 * Every arity here is its own route with every segment required, so this
 * only ever emits as many segments as there are real values to send - never
 * an empty placeholder for something unselected.
 */
function browseSegments(query: SearchQuery, tagId: string, sort: string): string[] {
	const loader = query.loaders?.[0] && query.loaders[0] !== 'vanilla' ? query.loaders[0] : '';
	const version = query.minecraftVersions?.[0] ?? query.minecraftVersion ?? '';
	const segments = [tagId, loader, version].filter(Boolean);
	segments.push(sort);
	if ((query.page ?? 1) > 1) segments.push(String(query.page));
	return segments;
}

function applyPostFilters(hits: SearchHit[], query: SearchQuery): SearchHit[] {
	let result = hits;
	const versions = query.minecraftVersions?.length
		? query.minecraftVersions
		: query.minecraftVersion
			? [query.minecraftVersion]
			: [];
	if (versions.length) {
		result = result.filter((h) => h.gameVersions.length === 0 || h.gameVersions.some((v) => versions.includes(v)));
	}
	if (query.loaders?.length) {
		result = result.filter((h) => h.loaders.length === 0 || h.loaders.some((l) => query.loaders!.includes(l)));
	}
	return result;
}

/**
 * The one real cross-catalog free-text search: takes a `term`, returns bare
 * id lists split by catalog (`packs` = FTB-native, `curseforge` = CurseForge
 * packs modpacks.ch also indexes). Both providers' term search goes through
 * this and each hydrates its own half via its own detail endpoint.
 */
async function sharedTermSearch(term: string, limit: number): Promise<SearchIds> {
	return fetchJson<SearchIds>(`${API}/public/modpack/search/${limit}?term=${encodeURIComponent(term)}`);
}

async function fetchTagList(url: string): Promise<Tag[]> {
	try {
		const data = await fetchJson<{ tags: Tag[] }>(url);
		return data.tags ?? [];
	} catch {
		return [];
	}
}

function loaderFilterGroup(): FilterGroup {
	return {
		id: 'loaders',
		label: 'Mod loader',
		options: ['fabric', 'forge', 'quilt', 'neoforge'].map((l) => ({
			value: l,
			label: l[0].toUpperCase() + l.slice(1)
		}))
	};
}

// --------------------------------------------------------------- ftb ---

function makeFtbProvider(): ModProvider {
	return {
		id: 'ftb',
		label: 'Feed the Beast',
		available: () => true,

		async search(query) {
			if (query.term) {
				const ids = await sharedTermSearch(query.term, query.limit ?? 20);
				const settled = await Promise.allSettled(
					(ids.packs ?? []).map((id) =>
						fetchJson<PackDetail>(`${API}/public/modpack/${id}`).then((p) => detailToHit('ftb', p))
					)
				);
				const hits = settled
					.filter((r): r is PromiseFulfilledResult<SearchHit> => r.status === 'fulfilled')
					.map((r) => r.value);
				return applyPostFilters(hits, query);
			}

			const segments = browseSegments(query, query.categories?.[0] ?? '', 'featured');
			const data = await fetchJson<{ packs: BrowseCard[] }>(
				`${API}/public/modpack/browse/${segments.join('/')}`
			);
			return (data.packs ?? []).slice(0, query.limit ?? 20).map((card) => cardToHit('ftb', card));
		},

		async getProject(id) {
			return detailToHit('ftb', await fetchJson<PackDetail>(`${API}/public/modpack/${id}`));
		},

		async listVersions(id, filter): Promise<ProjectVersion[]> {
			const pack = await fetchJson<PackDetail>(`${API}/public/modpack/${id}`);
			return (pack.versions ?? [])
				.filter(
					(v) => !filter?.minecraftVersion || targetsToGameVersions(v.targets).includes(filter.minecraftVersion)
				)
				.map((v) => ({
					id: String(v.id),
					projectId: id,
					name: v.name,
					versionNumber: v.name,
					channel: v.type ?? 'release',
					datePublished: v.updated ? new Date(v.updated * 1000).toISOString() : null,
					gameVersions: targetsToGameVersions(v.targets),
					loaders: targetsToLoaders(v.targets),
					changelog: null,
					files: [],
					dependencies: []
				}));
		},

		async getVersion(projectId, versionId): Promise<ProjectVersion> {
			const version = await fetchJson<VersionDetail>(`${API}/public/modpack/${projectId}/${versionId}`);
			return detailToVersion(String(projectId), version);
		},

		async description(id): Promise<string | null> {
			return packDescription('ftb', id);
		},

		async filterGroups(): Promise<FilterGroup[]> {
			const tags = await cached('ftb:tags', CACHE_TTL.TAGS, () => fetchTagList(`${API}/public/modpack/tags`));
			const categoryGroup: FilterGroup = {
				id: 'categories',
				label: 'Category',
				options: tags.map((t) => ({ value: String(t.id), label: t.name }))
			};
			return categoryGroup.options.length ? [loaderFilterGroup(), categoryGroup] : [loaderFilterGroup()];
		}
	};
}

// --------------------------------------------------------- curseforge ---

function makeCurseforgeProvider(): ModProvider {
	return {
		id: 'curseforge',
		label: 'CurseForge',
		available: () => true,
		unavailableReason: () =>
			'Browsing, filtering, and search all work without a key here. Add CURSEFORGE_API_KEY only for projects that block third-party downloads.',

		async search(query) {
			if (query.term) {
				const ids = await sharedTermSearch(query.term, query.limit ?? 20);
				const settled = await Promise.allSettled(
					(ids.curseforge ?? []).map((id) =>
						fetchJson<PackDetail>(`${API}/public/curseforge/${id}`).then((p) => detailToHit('curseforge', p))
					)
				);
				const hits = settled
					.filter((r): r is PromiseFulfilledResult<SearchHit> => r.status === 'fulfilled')
					.map((r) => r.value);
				return applyPostFilters(hits, query);
			}

			const kind = query.kind === 'mod' ? 'mod' : 'modpack';
			const tagId = query.categories?.[0] ?? '';
			const segments = browseSegments(query, tagId, 'featured');
			const base = kind === 'mod' ? `${API}/public/curseforge/mods/browse` : `${API}/public/curseforge/browse`;
			const data = await fetchJson<{ packs?: BrowseCard[]; mods?: BrowseCard[] }>(
				`${base}/${segments.join('/')}`
			);
			const cards = kind === 'mod' ? data.mods : data.packs;
			return (cards ?? []).slice(0, query.limit ?? 20).map((card) => cardToHit('curseforge', card));
		},

		async getProject(id) {
			return detailToHit('curseforge', await fetchJson<PackDetail>(`${API}/public/curseforge/${id}`));
		},

		async listVersions(id, filter): Promise<ProjectVersion[]> {
			const pack = await fetchJson<PackDetail>(`${API}/public/curseforge/${id}`);
			return (pack.versions ?? [])
				.filter(
					(v) => !filter?.minecraftVersion || targetsToGameVersions(v.targets).includes(filter.minecraftVersion)
				)
				.map((v) => ({
					id: String(v.id),
					projectId: id,
					name: v.name,
					versionNumber: v.name,
					channel: v.type ?? 'release',
					datePublished: v.updated ? new Date(v.updated * 1000).toISOString() : null,
					gameVersions: targetsToGameVersions(v.targets),
					loaders: targetsToLoaders(v.targets),
					changelog: null,
					files: [],
					dependencies: []
				}));
		},

		async getVersion(projectId, versionId): Promise<ProjectVersion> {
			const version = await fetchJson<VersionDetail>(`${API}/public/curseforge/${projectId}/${versionId}`);
			return detailToVersion(String(projectId), version);
		},

		async description(id): Promise<string | null> {
			return packDescription('curseforge', id);
		},

		async filterGroups(kind): Promise<FilterGroup[]> {
			const tagsPath = kind === 'mod' ? 'mods/tags' : 'tags';
			const tags = await cached(`curseforge:tags:${kind ?? 'modpack'}`, CACHE_TTL.TAGS, () =>
				fetchTagList(`${API}/public/curseforge/${tagsPath}`)
			);
			const categoryGroup: FilterGroup = {
				id: 'categories',
				label: 'Category',
				options: tags.map((t) => ({ value: String(t.id), label: t.name }))
			};
			return categoryGroup.options.length ? [loaderFilterGroup(), categoryGroup] : [loaderFilterGroup()];
		}
	};
}

export const curseforgeProvider = makeCurseforgeProvider();
export const ftbProvider = makeFtbProvider();

/** The pack's full description, which search results only carry truncated. */
export async function packDescription(source: 'curseforge' | 'ftb', projectId: string): Promise<string | null> {
	try {
		const path = source === 'curseforge' ? `curseforge/${projectId}` : `modpack/${projectId}`;
		const pack = await fetchJson<PackDetail>(`${API}/public/${path}`);
		return pack.description?.trim() || pack.synopsis?.trim() || null;
	} catch {
		return null;
	}
}
