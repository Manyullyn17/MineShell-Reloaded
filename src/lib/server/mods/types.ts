/**
 * One shape for every mod source. Modrinth is fully wired up; the modpacks.ch
 * bridge covers CurseForge and FTB browsing. A new platform means implementing
 * this interface and adding it to the registry in ./index.ts.
 */

export type SourceId = 'modrinth' | 'curseforge' | 'ftb' | 'manual';

export type SearchHit = {
	source: SourceId;
	/** Stable identifier used for every follow-up call. */
	id: string;
	slug: string;
	name: string;
	author: string | null;
	summary: string | null;
	iconUrl: string | null;
	downloads: number | null;
	projectUrl: string | null;
	/** Loaders the project declares support for, lower-cased. */
	loaders: string[];
	gameVersions: string[];
};

export type VersionFile = {
	filename: string;
	url: string;
	primary: boolean;
	hash: { algo: 'sha1' | 'sha512'; value: string } | null;
	size: number | null;
};

export type Dependency = {
	/** Project id on the same platform, when the platform gives one. */
	projectId: string | null;
	versionId: string | null;
	type: 'required' | 'optional' | 'incompatible' | 'embedded';
	name: string | null;
};

export type ProjectVersion = {
	id: string;
	/** The project this version belongs to - needed to fetch project metadata separately. */
	projectId: string;
	name: string;
	versionNumber: string;
	/** release | beta | alpha */
	channel: string;
	datePublished: string | null;
	gameVersions: string[];
	loaders: string[];
	changelog: string | null;
	files: VersionFile[];
	dependencies: Dependency[];
};

export type SearchQuery = {
	term: string;
	minecraftVersion?: string;
	/** Multi-select, OR'd together. Empty/absent means no loader restriction. */
	loaders?: string[];
	/** Multi-select, OR'd together. Category ids are provider-specific. */
	categories?: string[];
	/**
	 * For a mod search: which project types to include. Defaults to both mods
	 * and datapacks, since a datapack has no loader and would otherwise need a
	 * second query to include. Ignored for a modpack search, which always
	 * searches project_type:modpack regardless of this.
	 */
	projectTypes?: ('mod' | 'datapack')[];
	/** 'mod' or 'modpack' */
	kind: 'mod' | 'modpack';
	page?: number;
	limit?: number;
};

/** One filter group for the browse sidebar: a label and its checkable options. */
export type FilterGroup = {
	id: string;
	label: string;
	options: { value: string; label: string }[];
};

export interface ModProvider {
	id: SourceId;
	label: string;
	/** False when the provider needs a key the user has not supplied. */
	available(): boolean;
	unavailableReason?(): string;
	search(query: SearchQuery): Promise<SearchHit[]>;
	getProject(id: string): Promise<SearchHit>;
	listVersions(
		id: string,
		filter?: { minecraftVersion?: string; loader?: string }
	): Promise<ProjectVersion[]>;
	getVersion(projectId: string, versionId: string): Promise<ProjectVersion>;
	/**
	 * The filter groups this provider can actually apply, for the given search
	 * kind. Absent or empty means the browse UI shows no filter sidebar for
	 * this provider - true for a source with no facet system to speak of.
	 */
	filterGroups?(kind: 'mod' | 'modpack'): Promise<FilterGroup[]>;
}
