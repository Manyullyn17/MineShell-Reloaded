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
	files?: {
		name: string;
		path?: string;
		url: string;
		sha1?: string;
		size?: number;
		clientonly?: boolean;
		curseforge?: { project: string | number; file: string | number };
	}[];
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

/** The latest of the mirror's epoch-second timestamps, as ISO. */
function newest(times: (number | undefined)[] | undefined): string | null {
	const latest = Math.max(0, ...(times ?? []).filter((t): t is number => typeof t === 'number'));
	return latest ? new Date(latest * 1000).toISOString() : null;
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
		updatedAt: newest(pack.versions?.map((v) => v.updated)),
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
		loaderVersions: Object.fromEntries(
			(version.targets ?? [])
				.filter((t) => t.type === 'modloader' && t.version && t.version !== t.name)
				.map((t) => [t.name.toLowerCase(), t.version])
		),
		changelog: version.changelog?.trim() || null,
		files: files.map((f) => ({
			filename: f.name,
			path: f.path,
			url: f.url,
			primary: true,
			size: f.size ?? null,
			hash: f.sha1 ? { algo: 'sha1' as const, value: f.sha1 } : null,
			...(f.curseforge
				? { curseforge: { projectId: String(f.curseforge.project), fileId: String(f.curseforge.file) } }
				: {})
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
	return segments;
}

/** The mirror's browse lists come 50 to a page. */
const BROWSE_PAGE = 50;

/**
 * One page of our size (`query.limit`, 20) out of the mirror's 50-card browse
 * pages: page 2 is cards 21-40 of the mirror's first page, page 3 spans its
 * first and second. Past the last page the mirror answers "No packs."
 */
async function browseCards(
	url: (mirrorPage: number) => string,
	pick: (data: { packs?: BrowseCard[]; mods?: BrowseCard[] }) => BrowseCard[] | undefined,
	query: SearchQuery
): Promise<BrowseCard[]> {
	const limit = query.limit ?? 20;
	const start = ((query.page ?? 1) - 1) * limit;
	const first = Math.floor(start / BROWSE_PAGE) + 1;
	const last = Math.floor((start + limit - 1) / BROWSE_PAGE) + 1;
	const cards: BrowseCard[] = [];
	for (let page = first; page <= last; page++) {
		const data = await fetchJson<{ packs?: BrowseCard[]; mods?: BrowseCard[] }>(url(page));
		const list = pick(data) ?? [];
		cards.push(...list);
		if (list.length < BROWSE_PAGE) break;
	}
	const skip = start - (first - 1) * BROWSE_PAGE;
	return cards.slice(skip, skip + limit);
}

/** Term search answers the first `n` ids; a later page asks for more and keeps its share. */
function pageOfIds<T>(ids: T[] | undefined, query: SearchQuery): T[] {
	const limit = query.limit ?? 20;
	return (ids ?? []).slice(((query.page ?? 1) - 1) * limit, (query.page ?? 1) * limit);
}

const idsWanted = (query: SearchQuery) => (query.limit ?? 20) * (query.page ?? 1);

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
				const ids = await sharedTermSearch(query.term, idsWanted(query));
				const settled = await Promise.allSettled(
					pageOfIds(ids.packs, query).map((id) =>
						fetchJson<PackDetail>(`${API}/public/modpack/${id}`).then((p) => detailToHit('ftb', p))
					)
				);
				const hits = settled
					.filter((r): r is PromiseFulfilledResult<SearchHit> => r.status === 'fulfilled')
					.map((r) => r.value);
				return applyPostFilters(hits, query);
			}

			const segments = browseSegments(query, query.categories?.[0] ?? '', 'featured');
			const cards = await browseCards(
				(page) => `${API}/public/modpack/browse/${[...segments, ...(page > 1 ? [page] : [])].join('/')}`,
				(data) => data.packs,
				query
			).catch((err) => {
				if ((query.page ?? 1) > 1) return [];
				throw err;
			});
			return cards.map((card) => cardToHit('ftb', card));
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
				const ids = await sharedTermSearch(query.term, idsWanted(query));
				const settled = await Promise.allSettled(
					pageOfIds(ids.curseforge, query).map((id) =>
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
			const cards = await browseCards(
				(page) => `${base}/${[...segments, ...(page > 1 ? [page] : [])].join('/')}`,
				(data) => (kind === 'mod' ? data.mods : data.packs),
				query
			).catch((err) => {
				if ((query.page ?? 1) > 1) return [];
				throw err;
			});
			return cards.map((card) => cardToHit('curseforge', card));
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

// ---------------------------------------------------- curseforge mods ---

/**
 * Single CurseForge mods live under /public/mod/{id}, not the pack endpoints:
 * there every file carries its download URL, sha1, size and dependencies
 * (the pack endpoint lists a mod's versions with none of that). Both only
 * hold the newest 50 files, so a mod for an older Minecraft version is read
 * from /public/mod/{id}/versions/{mc}[/{loader}][/{page}], paged newest
 * first. The term search covers Modrinth too: numeric ids are CurseForge,
 * strings Modrinth.
 */

type ModFile = {
	id: number;
	/** The jar's file name. */
	name: string;
	/** Display label ("4.16.6.1033 for Forge 1.12.2"); older files repeat the file name. */
	version?: string;
	type?: string;
	updated?: number;
	url: string;
	sha1?: string;
	size?: number;
	clientonly?: boolean;
	targets?: Target[];
	dependencies?: { id: number; required: boolean }[];
};

type ModDetail = Omit<PackDetail, 'versions'> & {
	versions?: ModFile[];
	links?: { link: string; type: string }[];
	tags?: Tag[];
};

type ModFilePage = { versions?: ModFile[]; page?: number; pages?: number };

/** Pages walked to find one file of an older Minecraft version; a big mod has a handful. */
const MAX_FILE_PAGES = 20;

function modDetail(id: string): Promise<ModDetail> {
	return cached(`mirror:mod:${id}`, CACHE_TTL.DEFAULT, () =>
		fetchJson<ModDetail>(`${API}/public/mod/${encodeURIComponent(id)}`)
	);
}

function modFilePage(id: string, minecraftVersion: string, loader?: string, page = 1): Promise<ModFilePage> {
	const segments = [id, 'versions', minecraftVersion, loader, page > 1 ? String(page) : undefined]
		.filter((s): s is string => Boolean(s))
		.map(encodeURIComponent);
	return cached(`mirror:mod-files:${segments.join('/')}`, CACHE_TTL.DEFAULT, () =>
		fetchJson<ModFilePage>(`${API}/public/mod/${segments.join('/')}`)
	);
}

function modFileToVersion(projectId: string, file: ModFile): ProjectVersion {
	const label = file.version && file.version !== String(file.id) ? file.version : file.name;
	return {
		id: String(file.id),
		projectId,
		name: label,
		versionNumber: label,
		channel: file.type ?? 'release',
		datePublished: file.updated ? new Date(file.updated * 1000).toISOString() : null,
		gameVersions: targetsToGameVersions(file.targets),
		loaders: targetsToLoaders(file.targets),
		changelog: null,
		files: [
			{
				filename: file.name,
				url: file.url,
				primary: true,
				size: file.size ?? null,
				hash: file.sha1 ? { algo: 'sha1', value: file.sha1 } : null
			}
		],
		dependencies: (file.dependencies ?? []).map((d) => ({
			projectId: String(d.id),
			versionId: null,
			type: d.required ? 'required' : 'optional',
			name: null
		})),
		clientOnly: file.clientonly === true
	};
}

function modDetailToHit(mod: ModDetail, files: ModFile[] = mod.versions ?? []): SearchHit {
	return {
		source: 'curseforge',
		id: String(mod.id),
		// Every follow-up call takes the numeric id, and it is what gets stored
		// as a CurseForge mod's slug (see the mods table).
		slug: String(mod.id),
		name: mod.name,
		author: mod.authors?.[0]?.name ?? null,
		summary: mod.synopsis?.trim() || null,
		iconUrl: artUrl(mod),
		downloads: mod.installs ?? null,
		updatedAt: newest(files.map((f) => f.updated)),
		// The project page is type "curseforge" here, "website" on the pack endpoint.
		projectUrl: mod.links?.find((l) => l.type === 'curseforge' || l.type === 'website')?.link ?? null,
		loaders: [...new Set(files.flatMap((f) => targetsToLoaders(f.targets)))],
		gameVersions: [...new Set(files.flatMap((f) => targetsToGameVersions(f.targets)))]
	};
}

/**
 * One term-search result, or null when it does not fit the query. The
 * project's own file list is only the newest 50 files, so a Minecraft
 * version filter checks that version's files instead.
 */
async function modSearchHit(id: string, query: SearchQuery): Promise<SearchHit | null> {
	const mod = await modDetail(id);
	if (query.categories?.length && !mod.tags?.some((t) => query.categories!.includes(String(t.id)))) return null;

	const minecraftVersion = query.minecraftVersions?.[0] ?? query.minecraftVersion;
	const files = minecraftVersion ? ((await modFilePage(id, minecraftVersion)).versions ?? []) : (mod.versions ?? []);
	if (minecraftVersion && files.length === 0) return null;

	const loaders = query.loaders?.filter((l) => l !== 'vanilla') ?? [];
	// Files with no loader tag (common on old 1.12 mods) fit any loader.
	const fits = files.some((f) => {
		const tagged = targetsToLoaders(f.targets);
		return loaders.length === 0 || tagged.length === 0 || tagged.some((l) => loaders.includes(l));
	});
	return fits ? modDetailToHit(mod, files) : null;
}

function makeCurseforgeModProvider(): ModProvider {
	const packs = makeCurseforgeProvider();
	return {
		id: 'curseforge',
		label: 'CurseForge',
		available: () => true,

		async search(query) {
			if (!query.term) return packs.search({ ...query, kind: 'mod' });
			// The list mixes in Modrinth ids (strings); a page is cut from the CurseForge ones.
			const ids = await fetchJson<{ mods?: (number | string)[] }>(
				`${API}/public/mod/search/${idsWanted(query)}?term=${encodeURIComponent(query.term)}`
			);
			const curseforge = (ids.mods ?? []).filter((id) => typeof id === 'number');
			const settled = await Promise.allSettled(
				pageOfIds(curseforge, query).map((id) => modSearchHit(String(id), query))
			);
			return settled
				.filter((r): r is PromiseFulfilledResult<SearchHit | null> => r.status === 'fulfilled')
				.map((r) => r.value)
				.filter((hit): hit is SearchHit => hit !== null);
		},

		async getProject(id) {
			return modDetailToHit(await modDetail(id));
		},

		async listVersions(id, filter): Promise<ProjectVersion[]> {
			const files = filter?.minecraftVersion
				? ((await modFilePage(id, filter.minecraftVersion, filter.loader)).versions ?? [])
				: ((await modDetail(id)).versions ?? []).filter(
						(f) => !filter?.loader || targetsToLoaders(f.targets).includes(filter.loader)
					);
			return files.map((f) => modFileToVersion(id, f));
		},

		async getVersion(projectId, versionId, context): Promise<ProjectVersion> {
			const wanted = Number(versionId);
			let file = (await modDetail(projectId)).versions?.find((f) => f.id === wanted);
			const minecraftVersion = context?.minecraftVersion;
			for (let page = 1; !file && minecraftVersion && page <= MAX_FILE_PAGES; page++) {
				const result = await modFilePage(projectId, minecraftVersion, undefined, page);
				file = result.versions?.find((f) => f.id === wanted);
				if (page >= (result.pages ?? 1)) break;
			}
			if (!file) {
				throw new Error(`CurseForge file ${versionId} of project ${projectId} is not on the modpacks.ch mirror.`);
			}
			return modFileToVersion(projectId, file);
		},

		async description(id): Promise<string | null> {
			const mod = await modDetail(id);
			return mod.description?.trim() || mod.synopsis?.trim() || null;
		},

		filterGroups: () => packs.filterGroups!('mod')
	};
}

export const curseforgeProvider = makeCurseforgeProvider();
export const curseforgeModProvider = makeCurseforgeModProvider();
export const ftbProvider = makeFtbProvider();

/** The pack's full description, which search results only carry truncated. */
/**
 * Every file of a CurseForge or FTB pack version, client-only ones included
 * (getVersion leaves those out: a server install has no use for them). For
 * the client pack export.
 */
export async function packVersionFiles(
	source: 'curseforge' | 'ftb',
	projectId: string,
	versionId: string
): Promise<NonNullable<VersionDetail['files']>> {
	const base = source === 'ftb' ? `${API}/public/modpack` : `${API}/public/curseforge`;
	return (await fetchJson<VersionDetail>(`${base}/${projectId}/${versionId}`)).files ?? [];
}

export async function packDescription(source: 'curseforge' | 'ftb', projectId: string): Promise<string | null> {
	try {
		const path = source === 'curseforge' ? `curseforge/${projectId}` : `modpack/${projectId}`;
		const pack = await fetchJson<PackDetail>(`${API}/public/${path}`);
		return pack.description?.trim() || pack.synopsis?.trim() || null;
	} catch {
		return null;
	}
}
