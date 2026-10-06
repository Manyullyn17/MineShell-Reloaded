import { cached, CACHE_TTL } from '../cache';
import { getCurseforgeApiKey } from '../curseforge';
import type { FilterGroup, ProjectVersion, SearchHit, SearchQuery } from './types';

/**
 * CurseForge's own API (api.curseforge.com), used for metadata - search,
 * browse, project details, description and changelog - once a working key is
 * configured. This is deliberately metadata-only: the actual install-time
 * file list for a modpack version still comes from modpacks.ch (see
 * ./curseforge.ts), because a CurseForge modpack "file" through this API is
 * the pack's zip (manifest.json + overrides), not a pre-flattened per-mod
 * URL list the way modpacks.ch conveniently hands back. Turning this into a
 * full install-time source too would mean downloading that zip, parsing its
 * manifest (the same parser `lib/server/packs/index.ts` already uses for
 * uploaded CurseForge zips), and resolving each project/file id pair
 * individually. Installing from a pack's server pack instead was looked at and
 * rejected (docs/ROADMAP.md, "Considered and rejected").
 *
 * Endpoint shapes below are per CurseForge's published API docs
 * (https://docs.curseforge.com/), not live-verified against a real key in
 * this environment (none was available) - only the auth-failure path
 * (missing/invalid key -> 401/403) has actually been exercised here. Treat
 * the success-path field mapping as "implemented per spec," and recheck
 * against a real response if search results or version metadata look wrong
 * once a working key is in place.
 */

const API = 'https://api.curseforge.com/v1';
const MINECRAFT_GAME_ID = 432;
const CLASS_ID = { modpack: 4471, mod: 6 } as const;

/** developer.curseforge.com's ModLoaderType enum. */
const LOADER_TO_ENUM: Record<string, number> = {
	forge: 1,
	fabric: 4,
	quilt: 5,
	neoforge: 6
};
const ENUM_TO_LOADER = new Map(Object.entries(LOADER_TO_ENUM).map(([name, id]) => [id, name]));

/** Thrown so callers can tell an auth rejection apart from a network hiccup. */
export class CurseforgeAuthError extends Error {}

async function cfFetch<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
	const key = getCurseforgeApiKey();
	const query = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== '') query.set(k, String(v));
	}
	const suffix = query.toString() ? `?${query}` : '';
	const url = `${API}${path}${suffix}`;
	const res = await fetch(url, { headers: { 'x-api-key': key, Accept: 'application/json' } });
	if (res.status === 401 || res.status === 403) {
		throw new CurseforgeAuthError(`CurseForge rejected the key (${res.status} ${res.statusText}) for ${path}.`);
	}
	if (!res.ok) {
		throw new Error(`${url} returned ${res.status} ${res.statusText}`);
	}
	return (await res.json()) as T;
}

type CfAuthor = { name: string };
type CfLogo = { thumbnailUrl?: string; url?: string };
type CfLinks = { websiteUrl?: string };
type CfCategory = { id: number; name: string; isClass?: boolean; parentCategoryId?: number };
type CfFilesIndex = { gameVersion: string; modLoader?: number | null };

type CfMod = {
	id: number;
	name: string;
	slug: string;
	summary?: string;
	downloadCount?: number;
	logo?: CfLogo | null;
	authors?: CfAuthor[];
	links?: CfLinks;
	categories?: CfCategory[];
	latestFilesIndexes?: CfFilesIndex[];
	dateModified?: string;
};

type CfFile = {
	id: number;
	displayName: string;
	fileName: string;
	/** 1 release, 2 beta, 3 alpha - matches this app's channel priority keys once lower-cased. */
	releaseType?: number;
	fileDate?: string;
	gameVersions?: string[];
	downloadUrl?: string | null;
	fileLength?: number;
	hashes?: { value: string; algo: number }[];
};

function iconUrl(mod: CfMod): string | null {
	return mod.logo?.thumbnailUrl ?? mod.logo?.url ?? null;
}

/** `gameVersions` mixes real MC versions with loader names and "Client"/"Server" tags. */
function splitGameVersions(values: string[] | undefined): { gameVersions: string[]; loaders: string[] } {
	const gameVersions: string[] = [];
	const loaders: string[] = [];
	for (const raw of values ?? []) {
		const lower = raw.toLowerCase();
		if (lower in LOADER_TO_ENUM) loaders.push(lower);
		else if (/^\d+(\.\d+)+/.test(raw)) gameVersions.push(raw);
	}
	return { gameVersions, loaders };
}

function indexesToFacets(indexes: CfFilesIndex[] | undefined): { gameVersions: string[]; loaders: string[] } {
	const gameVersions = new Set<string>();
	const loaders = new Set<string>();
	for (const entry of indexes ?? []) {
		if (entry.gameVersion) gameVersions.add(entry.gameVersion);
		const loader = entry.modLoader != null ? ENUM_TO_LOADER.get(entry.modLoader) : undefined;
		if (loader) loaders.add(loader);
	}
	return { gameVersions: [...gameVersions], loaders: [...loaders] };
}

function modToHit(mod: CfMod): SearchHit {
	const { gameVersions, loaders } = indexesToFacets(mod.latestFilesIndexes);
	return {
		source: 'curseforge',
		id: String(mod.id),
		slug: mod.slug,
		name: mod.name,
		author: mod.authors?.[0]?.name ?? null,
		summary: mod.summary?.trim() || null,
		iconUrl: iconUrl(mod),
		downloads: mod.downloadCount ?? null,
		updatedAt: mod.dateModified ?? null,
		projectUrl: mod.links?.websiteUrl ?? null,
		loaders,
		gameVersions
	};
}

const RELEASE_TYPE: Record<number, string> = { 1: 'release', 2: 'beta', 3: 'alpha' };

function fileToVersion(projectId: string, file: CfFile, changelog: string | null): ProjectVersion {
	const { gameVersions, loaders } = splitGameVersions(file.gameVersions);
	return {
		id: String(file.id),
		projectId,
		name: file.displayName || file.fileName,
		versionNumber: file.displayName || file.fileName,
		channel: RELEASE_TYPE[file.releaseType ?? 1] ?? 'release',
		datePublished: file.fileDate ?? null,
		gameVersions,
		loaders,
		changelog,
		// Metadata-only: the real install-time file list for a modpack still
		// comes from the modpacks.ch mirror, see the module comment above.
		files: [],
		dependencies: []
	};
}

function classIdFor(kind: 'mod' | 'modpack' | undefined): number {
	return kind === 'mod' ? CLASS_ID.mod : CLASS_ID.modpack;
}

export async function fetchChangelog(modId: string, fileId: string): Promise<string | null> {
	try {
		const res = await cfFetch<{ data: string }>(`/mods/${modId}/files/${fileId}/changelog`);
		return res.data?.trim() || null;
	} catch {
		return null;
	}
}

export async function search(query: SearchQuery): Promise<SearchHit[]> {
	const loader = query.loaders?.find((l) => l !== 'vanilla');
	const data = await cfFetch<{ data: CfMod[] }>('/mods/search', {
		gameId: MINECRAFT_GAME_ID,
		classId: classIdFor(query.kind),
		searchFilter: query.term || undefined,
		categoryId: query.categories?.[0],
		gameVersion: query.minecraftVersions?.[0] ?? query.minecraftVersion,
		modLoaderType: loader ? LOADER_TO_ENUM[loader] : undefined,
		sortField: 2, // Popularity
		sortOrder: 'desc',
		pageSize: query.limit ?? 20,
		index: ((query.page ?? 1) - 1) * (query.limit ?? 20)
	});
	return (data.data ?? []).map(modToHit);
}

export async function getProject(id: string): Promise<SearchHit> {
	const data = await cfFetch<{ data: CfMod }>(`/mods/${id}`);
	return modToHit(data.data);
}

export async function description(id: string): Promise<string | null> {
	const data = await cfFetch<{ data: string }>(`/mods/${id}/description`);
	return data.data?.trim() || null;
}

export async function listVersions(
	id: string,
	filter?: { minecraftVersion?: string; loader?: string }
): Promise<ProjectVersion[]> {
	const data = await cfFetch<{ data: CfFile[] }>(`/mods/${id}/files`, {
		gameVersion: filter?.minecraftVersion,
		pageSize: 50
	});
	return (data.data ?? []).map((file) => fileToVersion(id, file, null));
}

export async function getVersion(projectId: string, versionId: string): Promise<ProjectVersion> {
	const [fileRes, changelog] = await Promise.all([
		cfFetch<{ data: CfFile }>(`/mods/${projectId}/files/${versionId}`),
		fetchChangelog(projectId, versionId)
	]);
	return fileToVersion(projectId, fileRes.data, changelog);
}

export async function filterGroups(kind: 'mod' | 'modpack' | undefined): Promise<FilterGroup[]> {
	const classId = classIdFor(kind);
	const categories = await cached(`curseforge-official:categories:${classId}`, CACHE_TTL.TAGS, async () => {
		const data = await cfFetch<{ data: CfCategory[] }>('/categories', {
			gameId: MINECRAFT_GAME_ID,
			classId
		});
		return (data.data ?? []).filter((c) => !c.isClass);
	});

	const loaderGroup: FilterGroup = {
		id: 'loaders',
		label: 'Mod loader',
		options: Object.keys(LOADER_TO_ENUM).map((l) => ({ value: l, label: l[0].toUpperCase() + l.slice(1) }))
	};
	const categoryGroup: FilterGroup = {
		id: 'categories',
		label: 'Category',
		options: categories.map((c) => ({ value: String(c.id), label: c.name }))
	};
	return categoryGroup.options.length ? [loaderGroup, categoryGroup] : [loaderGroup];
}
