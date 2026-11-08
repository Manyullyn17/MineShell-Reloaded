import { cached, CACHE_TTL } from '../cache';
import { getCurseforgeApiKey } from '../curseforge';
import type { FilterGroup, ProjectVersion, SearchHit, SearchQuery } from './types';
import { outboundFetch } from '../outbound';

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
 * Written from CurseForge's published API docs (https://docs.curseforge.com/),
 * then checked against its real answers: curseforge-official-api.test.ts
 * replays them (recorded with a real key), curseforge-official.test.ts covers
 * paging and a key that stops being accepted.
 */

const API = 'https://api.curseforge.com/v1';
const MINECRAFT_GAME_ID = 432;
const CLASS_ID = { modpack: 4471, mod: 6, resourcePack: 12 } as const;

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

/** A GET, or with `body` a POST of it as JSON. */
async function cfFetch<T>(path: string, params: Record<string, string | number | undefined> = {}, body?: unknown): Promise<T> {
	const key = getCurseforgeApiKey();
	const query = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== '') query.set(k, String(v));
	}
	const suffix = query.toString() ? `?${query}` : '';
	const url = `${API}${path}${suffix}`;
	const res = await outboundFetch(
		url,
		body === undefined
			? { headers: { 'x-api-key': key, Accept: 'application/json' } }
			: { method: 'POST', headers: { 'x-api-key': key, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
	);
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

/** Several projects in one call, by id; ids CurseForge does not know are left out. */
export async function projectsByIds(ids: string[]): Promise<Map<string, SearchHit>> {
	const out = new Map<string, SearchHit>();
	const unique = [...new Set(ids)];
	for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
		const data = await cfFetch<{ data: CfMod[] }>('/mods', {}, { modIds: unique.slice(i, i + LOOKUP_CHUNK).map(Number) });
		for (const mod of data.data ?? []) out.set(String(mod.id), modToHit(mod));
	}
	return out;
}

/** What a fingerprint lookup matched: the project, the file and its label. */
export type FingerprintMatch = { projectId: string; fileId: string; version: string };

/**
 * Files by their fingerprint (fingerprint.ts), exact matches only. The modpacks.ch mirror has
 * no such lookup, so this needs the key. A jar CurseForge does not have is left out.
 */
export async function filesByFingerprints(fingerprints: number[]): Promise<Map<number, FingerprintMatch>> {
	const out = new Map<number, FingerprintMatch>();
	const unique = [...new Set(fingerprints)];
	for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
		const data = await cfFetch<{ data: { exactMatches?: { id: number; file: CfFile & { modId: number; fileFingerprint: number } }[] } }>(
			`/fingerprints/${MINECRAFT_GAME_ID}`,
			{},
			{ fingerprints: unique.slice(i, i + LOOKUP_CHUNK) }
		);
		for (const match of data.data?.exactMatches ?? []) {
			const file = match.file;
			out.set(file.fileFingerprint, { projectId: String(file.modId), fileId: String(file.id), version: file.displayName || file.fileName });
		}
	}
	return out;
}

/** Ids or fingerprints per request, like Modrinth's hash lookup. */
const LOOKUP_CHUNK = 100;

export async function description(id: string): Promise<string | null> {
	const data = await cfFetch<{ data: string }>(`/mods/${id}/description`);
	return data.data?.trim() || null;
}

/** Enough for any real project; the API refuses an index past 10000 anyway. */
const MAX_FILE_PAGES = 40;

export async function listVersions(
	id: string,
	filter?: { minecraftVersion?: string; loader?: string }
): Promise<ProjectVersion[]> {
	// 50 files a page (the API's most), newest first; a big pack has hundreds.
	const files: CfFile[] = [];
	for (let page = 0; page < MAX_FILE_PAGES; page++) {
		const data = await cfFetch<{ data: CfFile[]; pagination?: { totalCount?: number } }>(`/mods/${id}/files`, {
			gameVersion: filter?.minecraftVersion,
			pageSize: 50,
			index: page * 50
		});
		files.push(...(data.data ?? []));
		if (!data.data?.length || files.length >= (data.pagination?.totalCount ?? 0)) break;
	}
	return files.map((file) => fileToVersion(id, file, null));
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

/**
 * Resource packs (their own class), popular first, for one Minecraft version. The mirror's term
 * search does not find them (Fresh Animations, Better Leaves, 2026-11-08), so this needs the key.
 */
export async function searchResourcePacks(term: string, minecraftVersion: string, page = 1, limit = 20): Promise<SearchHit[]> {
	const data = await cfFetch<{ data: CfMod[] }>('/mods/search', {
		gameId: MINECRAFT_GAME_ID,
		classId: CLASS_ID.resourcePack,
		searchFilter: term || undefined,
		gameVersion: minecraftVersion || undefined,
		sortField: 2, // Popularity
		sortOrder: 'desc',
		pageSize: limit,
		index: (page - 1) * limit
	});
	return (data.data ?? []).map(modToHit);
}

/** A file as players' games would download it: no URL for a project that opted out of other sites. */
export type CfPackFile = { id: string; name: string; fileName: string; channel: string; date: string | null; gameVersions: string[]; url: string | null; sha1: string | null; size: number | null };

/** A project's files for one Minecraft version, newest first (the first 50 are plenty for a pack). */
export async function resourcePackFiles(id: string, minecraftVersion: string): Promise<CfPackFile[]> {
	const data = await cfFetch<{ data: CfFile[] }>(`/mods/${id}/files`, { gameVersion: minecraftVersion || undefined, pageSize: 50 });
	return (data.data ?? []).map((file) => ({
		id: String(file.id),
		name: file.displayName || file.fileName,
		fileName: file.fileName,
		channel: RELEASE_TYPE[file.releaseType ?? 1] ?? 'release',
		date: file.fileDate ?? null,
		gameVersions: splitGameVersions(file.gameVersions).gameVersions,
		url: file.downloadUrl || null,
		// algo 1 is SHA-1, 2 MD5.
		sha1: file.hashes?.find((h) => h.algo === 1)?.value ?? null,
		size: file.fileLength ?? null
	}));
}
