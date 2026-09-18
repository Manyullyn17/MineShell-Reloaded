import { fetchJson } from '../download';
import { cached, CACHE_TTL } from '../cache';
import type { FilterGroup, ModProvider, ProjectVersion, SearchHit, SearchQuery } from './types';

const API = 'https://api.modrinth.com/v2';

/**
 * `environment` replaces the older client_side/server_side pair (both are
 * deprecated on v2's own search facets, despite the version number).
 * `client_only` is excluded outright. `singleplayer_only` is excluded too:
 * it was meant as another client-only signal, but under the old two-field
 * system people would mark a mod server_side because it runs on the
 * integrated server in singleplayer - even though it does nothing on an
 * actual dedicated server. Everything else keeps some real server role, or
 * is simply unlabelled, and hiding those on a guess would cost more than it
 * saves.
 */
const EXCLUDED_ENVIRONMENTS = ['client_only', 'singleplayer_only'];

type MrSearchResponse = {
	hits: {
		project_id: string;
		slug: string;
		title: string;
		author: string;
		description: string;
		icon_url: string | null;
		downloads: number;
		categories: string[];
		versions: string[];
	}[];
};

type MrProject = {
	id: string;
	slug: string;
	title: string;
	description: string;
	/** Full markdown page body, absent from search results. */
	body?: string;
	icon_url: string | null;
	downloads: number;
	loaders: string[];
	game_versions: string[];
	team: string;
};

type MrVersion = {
	id: string;
	project_id: string;
	name: string;
	version_number: string;
	version_type: string;
	date_published: string;
	game_versions: string[];
	loaders: string[];
	changelog: string | null;
	files: {
		filename: string;
		url: string;
		primary: boolean;
		size: number;
		hashes: { sha1?: string; sha512?: string };
	}[];
	dependencies: {
		project_id: string | null;
		version_id: string | null;
		dependency_type: string;
		file_name: string | null;
	}[];
};

type MrTag = { name: string; project_type: string };

function toHit(project: MrProject | MrSearchResponse['hits'][number]): SearchHit {
	const isSearch = 'project_id' in project;
	return {
		source: 'modrinth',
		id: isSearch ? project.project_id : project.id,
		slug: project.slug,
		name: isSearch ? project.title : project.title,
		author: isSearch ? project.author : null,
		summary: project.description,
		iconUrl: project.icon_url,
		downloads: project.downloads,
		projectUrl: `https://modrinth.com/project/${project.slug}`,
		// Search hits have no `loaders` field of their own - the loader is
		// lumped into `categories` there, while a full project fetch carries a
		// real `loaders` array. Two different shapes for the same fact.
		loaders: isSearch ? [] : project.loaders.map((l) => l.toLowerCase()),
		gameVersions: isSearch ? project.versions : project.game_versions
	};
}

function toVersion(version: MrVersion): ProjectVersion {
	return {
		id: version.id,
		projectId: version.project_id,
		name: version.name,
		versionNumber: version.version_number,
		channel: version.version_type,
		datePublished: version.date_published,
		gameVersions: version.game_versions,
		loaders: version.loaders.map((l) => l.toLowerCase()),
		changelog: version.changelog,
		files: version.files.map((file) => ({
			filename: file.filename,
			url: file.url,
			primary: file.primary,
			size: file.size,
			hash: file.hashes.sha512
				? { algo: 'sha512' as const, value: file.hashes.sha512 }
				: file.hashes.sha1
					? { algo: 'sha1' as const, value: file.hashes.sha1 }
					: null
		})),
		dependencies: version.dependencies.map((dep) => ({
			projectId: dep.project_id,
			versionId: dep.version_id,
			type: dep.dependency_type as 'required' | 'optional' | 'incompatible' | 'embedded',
			name: dep.file_name
		}))
	};
}

function buildFacets(query: SearchQuery): string[][] {
	const facets: string[][] = [];

	// Environment is an AND-of-ORs system: to exclude one value, include every
	// value except it, in one OR group.
	facets.push(
		[
			'client_and_server',
			'client_only_server_optional',
			'server_only',
			'server_only_client_optional',
			'dedicated_server_only',
			'client_or_server',
			'client_or_server_prefers_both',
			'singleplayer_only',
			'unknown'
		].filter((env) => !EXCLUDED_ENVIRONMENTS.includes(env))
			.map((env) => `environment:${env}`)
	);

	if (query.kind === 'modpack') {
		facets.push(['project_type:modpack']);
	} else {
		const types = query.projectTypes?.length ? query.projectTypes : ['mod', 'datapack'];
		facets.push(types.map((t) => `project_type:${t}`));
	}

	{
		const versions = query.minecraftVersions?.length
			? query.minecraftVersions
			: query.minecraftVersion
				? [query.minecraftVersion]
				: [];
		if (versions.length) facets.push(versions.map((v) => `versions:${v}`));
	}

	if (query.categories?.length) {
		facets.push(query.categories.map((c) => `categories:${c}`));
	}

	if (query.loaders?.length) {
		// A datapack has no loader, so a loader filter would otherwise hide
		// every datapack even when "datapack" is one of the selected types.
		// Folding categories:datapack into the same OR group means a datapack
		// still matches this clause on its own terms, without a second query.
		const loaderFacets = query.loaders.map((l) => `categories:${l}`);
		const types = query.projectTypes?.length ? query.projectTypes : ['mod', 'datapack'];
		if (types.includes('datapack')) loaderFacets.push('categories:datapack');
		facets.push(loaderFacets);
	}

	return facets;
}

export const modrinthProvider: ModProvider = {
	id: 'modrinth',
	label: 'Modrinth',
	available: () => true,

	async search(query: SearchQuery): Promise<SearchHit[]> {
		const params = new URLSearchParams({
			limit: String(query.limit ?? 20),
			offset: String(((query.page ?? 1) - 1) * (query.limit ?? 20)),
			index: query.term ? 'relevance' : 'downloads',
			facets: JSON.stringify(buildFacets(query))
		});
		if (query.term) params.set('query', query.term);

		const data = await fetchJson<MrSearchResponse>(`${API}/search?${params}`);
		return data.hits.map(toHit);
	},

	async getProject(id: string): Promise<SearchHit> {
		const project = await fetchJson<MrProject>(`${API}/project/${encodeURIComponent(id)}`);
		return toHit(project);
	},

	async listVersions(id, filter): Promise<ProjectVersion[]> {
		const params = new URLSearchParams();
		if (filter?.minecraftVersion) {
			params.set('game_versions', JSON.stringify([filter.minecraftVersion]));
		}
		if (filter?.loader && filter.loader !== 'vanilla') {
			params.set('loaders', JSON.stringify([filter.loader]));
		}
		const suffix = params.toString() ? `?${params}` : '';
		const versions = await fetchJson<MrVersion[]>(
			`${API}/project/${encodeURIComponent(id)}/version${suffix}`
		);
		return versions.map(toVersion);
	},

	async getVersion(_projectId, versionId): Promise<ProjectVersion> {
		const version = await fetchJson<MrVersion>(`${API}/version/${encodeURIComponent(versionId)}`);
		return toVersion(version);
	},

	async description(id): Promise<string | null> {
		return projectBody(id);
	},

	async filterGroups(kind): Promise<FilterGroup[]> {
		const [categories, loaders] = await Promise.all([fetchCategoryTags(), fetchLoaderTags()]);

		const wantedTypes = kind === 'modpack' ? ['modpack'] : ['mod', 'datapack'];
		const categoryOptions = categories
			.filter((tag) => wantedTypes.includes(tag.project_type))
			.map((tag) => ({ value: tag.name, label: titleCase(tag.name) }));

		const groups: FilterGroup[] = [
			{ id: 'loaders', label: 'Mod loader', options: loaders.map((l) => ({ value: l, label: titleCase(l) })) },
			{ id: 'categories', label: 'Category', options: categoryOptions }
		];

		if (kind === 'mod') {
			groups.push({
				id: 'projectTypes',
				label: 'Type',
				options: [
					{ value: 'mod', label: 'Mod' },
					{ value: 'datapack', label: 'Datapack' }
				]
			});
		}

		return groups;
	}
};

function titleCase(s: string): string {
	return s.replace(/(^|[\s-])(\w)/g, (_, sep, ch) => sep + ch.toUpperCase());
}

const KNOWN_LOADERS = new Set(['fabric', 'forge', 'quilt', 'neoforge']);

async function fetchCategoryTags(): Promise<MrTag[]> {
	return cached('modrinth:tags:category', CACHE_TTL.TAGS, () =>
		fetchJson<MrTag[]>(`${API}/tag/category`)
	);
}

async function fetchLoaderTags(): Promise<string[]> {
	// The loader tag endpoint lists every loader tag Modrinth knows about,
	// including data-generation and resource-pack tooling that is not a
	// server mod loader; filtered down to the ones MineShell can actually run.
	type MrLoaderTag = { name: string };
	const tags = await cached('modrinth:tags:loader', CACHE_TTL.TAGS, () =>
		fetchJson<MrLoaderTag[]>(`${API}/tag/loader`)
	);
	return tags.map((t) => t.name.toLowerCase()).filter((name) => KNOWN_LOADERS.has(name));
}

/** Used by the pack importer to turn a manifest hash back into a download URL. */
/**
 * Identifies many files in one request. Modrinth's version_files endpoint takes
 * a batch of hashes and returns the versions it recognises, which turns
 * "identify a 120-mod pack" from 120 round trips into one.
 */
export async function versionsFromHashes(
	hashes: string[]
): Promise<Map<string, ProjectVersion>> {
	const found = new Map<string, ProjectVersion>();
	if (hashes.length === 0) return found;

	// Chunked so a huge pack cannot produce an unreasonable request body.
	const CHUNK = 100;
	for (let i = 0; i < hashes.length; i += CHUNK) {
		const slice = hashes.slice(i, i + CHUNK);
		try {
			const response = await fetchJson<Record<string, MrVersion>>(`${API}/version_files`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ hashes: slice, algorithm: 'sha512' })
			});
			for (const [hash, version] of Object.entries(response ?? {})) {
				if (version) found.set(hash, toVersion(version));
			}
		} catch {
			// A failed chunk just means those files stay unidentified.
		}
	}
	return found;
}

/**
 * Fetches several projects at once, for naming a batch of identified files.
 * Client-only projects are dropped, same reasoning as the search filter -
 * naming a mod is not the same as saying it belongs on a dedicated server.
 */
export async function projectsByIds(ids: string[]): Promise<Map<string, SearchHit>> {
	const out = new Map<string, SearchHit>();
	const unique = [...new Set(ids)];
	if (unique.length === 0) return out;

	try {
		type MrProjectWithEnv = MrProject & { environment?: string };
		const projects = await fetchJson<MrProjectWithEnv[]>(
			`${API}/projects?ids=${encodeURIComponent(JSON.stringify(unique))}`
		);
		for (const project of projects ?? []) {
			if (project.environment && EXCLUDED_ENVIRONMENTS.includes(project.environment)) continue;
			out.set(project.id, toHit(project));
		}
	} catch {
		// Fall back to leaving them unnamed; the caller tracks them as manual.
	}
	return out;
}

/** The project's full description page, as markdown. */
export async function projectBody(id: string): Promise<string | null> {
	try {
		const project = await fetchJson<MrProject>(`${API}/project/${encodeURIComponent(id)}`);
		return project.body?.trim() || null;
	} catch {
		return null;
	}
}

export async function versionFromHash(sha512: string): Promise<ProjectVersion | null> {
	try {
		const version = await fetchJson<MrVersion>(
			`${API}/version_file/${sha512}?algorithm=sha512`
		);
		return toVersion(version);
	} catch {
		return null;
	}
}
