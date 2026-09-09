import { fetchJson } from '../download';
import { cached, CACHE_TTL } from '../cache';
import { CURSEFORGE_API_KEY } from '../config';
import type { FilterGroup, ModProvider, ProjectVersion, SearchHit, SearchQuery, SourceId } from './types';

/**
 * modpacks.ch is the FTB App's public backend. It proxies CurseForge search and
 * serves FTB's own packs, which means MineShell can browse both without every
 * user needing a CurseForge API key. The endpoints and their quirks (an empty
 * `?term=` 500s, so it is omitted when browsing) come from the original design
 * doc's API notes.
 *
 * Direct CurseForge file downloads still need the official API when a project
 * has opted out of third-party distribution; CURSEFORGE_API_KEY covers that.
 */

const API = 'https://api.modpacks.ch';
const USER_KEY = 'public';

type SearchIds = { packs?: number[]; curseforge?: number[]; total?: number };

type PackDetail = {
	id: number;
	name: string;
	slug?: string;
	synopsis?: string;
	description?: string;
	authors?: { name: string }[];
	art?: { url: string; type: string }[];
	versions?: { id: number; name: string; type: string; updated: number; targets?: PackTarget[] }[];
	installs?: number;
	tags?: { name: string }[];
};

type PackTarget = { name: string; version: string; type: string };

function artUrl(pack: PackDetail): string | null {
	const square = pack.art?.find((a) => a.type === 'square') ?? pack.art?.[0];
	return square?.url ?? null;
}

function targetsToLoaders(targets: PackTarget[] | undefined): string[] {
	return (targets ?? []).filter((t) => t.type === 'modloader').map((t) => t.name.toLowerCase());
}

function targetsToGameVersions(targets: PackTarget[] | undefined): string[] {
	return (targets ?? []).filter((t) => t.type === 'game').map((t) => t.version);
}

function buildSearchUrl(source: 'curseforge' | 'ftb', query: SearchQuery, tagId: string): string {
	// Path shape: /{userKey}/[curseforge/]{search|mods/search}/{tag}/{loader}/{version}/{sortType}/{page}
	const segments =
		source === 'curseforge'
			? [USER_KEY, 'curseforge', query.kind === 'mod' ? 'mods' : null, 'search']
			: [USER_KEY, 'modpack', 'search'];

	// This API takes one tag id and one loader per request, not the AND-of-OR
	// facet system Modrinth has - there is no way to request "any of these
	// three categories" in one call. Only the first selected value is used;
	// the UI should make that limitation visible rather than silently
	// dropping the rest.
	const loader =
		query.loaders?.[0] && query.loaders[0] !== 'vanilla' ? query.loaders[0] : '';
	const version = query.minecraftVersion ?? '';
	const sortType = query.term ? 'popular' : 'featured';
	const page = String(query.page ?? 1);

	const path = [...segments.filter(Boolean), tagId, loader, version, sortType, page].join('/');
	// An empty term produces a 500 rather than a browse, so it is left off.
	const suffix = query.term ? `?term=${encodeURIComponent(query.term)}` : '';
	return `${API}/${path}${suffix}`;
}

async function detail(source: 'curseforge' | 'ftb', id: string): Promise<PackDetail> {
	const path =
		source === 'curseforge' ? `${API}/public/curseforge/modpack/${id}` : `${API}/public/modpack/${id}`;
	return fetchJson<PackDetail>(path);
}

function toHit(source: SourceId, pack: PackDetail): SearchHit {
	const targets = pack.versions?.[0]?.targets;
	return {
		source,
		id: String(pack.id),
		slug: pack.slug ?? String(pack.id),
		name: pack.name,
		author: pack.authors?.[0]?.name ?? null,
		summary: pack.synopsis ?? pack.description?.slice(0, 240) ?? null,
		iconUrl: artUrl(pack),
		downloads: pack.installs ?? null,
		projectUrl: source === 'ftb' ? `https://feed-the-beast.com/modpacks/${pack.id}` : null,
		loaders: targetsToLoaders(targets),
		gameVersions: targetsToGameVersions(targets)
	};
}

function makeProvider(source: 'curseforge' | 'ftb', label: string): ModProvider {
	return {
		id: source,
		label,
		available: () => true,
		unavailableReason: () =>
			source === 'curseforge' && !CURSEFORGE_API_KEY
				? 'Browsing works without a key. Some projects block third-party downloads; add CURSEFORGE_API_KEY to install those.'
				: '',

		async search(query) {
			// Same one-value limitation as loader: only the first selected
			// category can be sent.
			const tagId = query.categories?.[0] ?? '';
			const ids = await fetchJson<SearchIds>(buildSearchUrl(source, query, tagId));
			const list = (source === 'curseforge' ? ids.curseforge : ids.packs) ?? ids.packs ?? [];
			const top = list.slice(0, query.limit ?? 20);
			const details = await Promise.allSettled(top.map((id) => detail(source, String(id))));
			return details
				.filter(
					(r): r is PromiseFulfilledResult<PackDetail> =>
						r.status === 'fulfilled' && Boolean(r.value?.name)
				)
				.map((r) => toHit(source, r.value));
		},

		async getProject(id) {
			return toHit(source, await detail(source, id));
		},

		async listVersions(id, filter): Promise<ProjectVersion[]> {
			const pack = await detail(source, id);
			return (pack.versions ?? [])
				.filter((v) => {
					if (!filter?.minecraftVersion) return true;
					return targetsToGameVersions(v.targets).includes(filter.minecraftVersion);
				})
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
			const path =
				source === 'curseforge'
					? `${API}/public/curseforge/modpack/${projectId}/${versionId}`
					: `${API}/public/modpack/${projectId}/${versionId}`;
			const version = await fetchJson<{
				id: number;
				name: string;
				type: string;
				updated: number;
				targets?: PackTarget[];
				files?: { path: string; name: string; url: string; sha1: string; size: number }[];
			}>(path);
			return {
				id: String(version.id),
				projectId: String(projectId),
				name: version.name,
				versionNumber: version.name,
				channel: version.type ?? 'release',
				datePublished: version.updated ? new Date(version.updated * 1000).toISOString() : null,
				gameVersions: targetsToGameVersions(version.targets),
				loaders: targetsToLoaders(version.targets),
				changelog: null,
				files: (version.files ?? []).map((f) => ({
					filename: f.name,
					url: f.url,
					primary: true,
					size: f.size,
					hash: f.sha1 ? { algo: 'sha1' as const, value: f.sha1 } : null
				})),
				dependencies: []
			};
		},

		async filterGroups(): Promise<FilterGroup[]> {
			// This API has no separate loader-tag list; the mod loaders it can
			// filter by are the same fixed set every instance already targets.
			const loaderGroup: FilterGroup = {
				id: 'loaders',
				label: 'Mod loader',
				options: ['fabric', 'forge', 'quilt', 'neoforge'].map((l) => ({
					value: l,
					label: l[0].toUpperCase() + l.slice(1)
				}))
			};

			const categories = source === 'curseforge' ? await fetchCurseforgeTags() : [];
			const categoryGroup: FilterGroup = {
				id: 'categories',
				label: 'Category',
				options: categories.map((tag) => ({ value: String(tag.id), label: tag.name }))
			};

			// Only one value from either group can actually be applied (see
			// buildSearchUrl) - shown for real regardless, since even a single
			// working filter beats none, and the browse UI notes the limit.
			return categoryGroup.options.length ? [loaderGroup, categoryGroup] : [loaderGroup];
		}
	};
}

export const curseforgeProvider = makeProvider('curseforge', 'CurseForge');
export const ftbProvider = makeProvider('ftb', 'Feed the Beast');

type CfTag = { id: number; name: string };

/**
 * CurseForge's category list, via modpacks.ch. This endpoint is documented
 * but was never exercised against the live API during development (no
 * network access in the build environment), so a failure here degrades to
 * "no category filter" rather than breaking the browse page - the loader
 * filter still works either way.
 */
async function fetchCurseforgeTags(): Promise<CfTag[]> {
	try {
		return await cached('curseforge:tags', CACHE_TTL.TAGS, () =>
			fetchJson<CfTag[]>(`${API}/public/curseforge/mods/tags`)
		);
	} catch {
		return [];
	}
}

/** The pack's full description, which search results only carry truncated. */
export async function packDescription(
	source: 'curseforge' | 'ftb',
	projectId: string
): Promise<string | null> {
	try {
		const pack = await detail(source, projectId);
		return pack.description?.trim() || pack.synopsis?.trim() || null;
	} catch {
		return null;
	}
}

/** Changelog endpoint, kept separate because only FTB packs expose one here. */
export async function packChangelog(projectId: string, versionId: string): Promise<string | null> {
	try {
		const data = await fetchJson<{ content?: string }>(
			`${API}/public/modpack/${projectId}/${versionId}/changelog`
		);
		return data.content ?? null;
	} catch {
		return null;
	}
}
