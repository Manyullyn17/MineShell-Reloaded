import { curseforgeProvider as mirrorProvider, curseforgeModProvider as mirrorModProvider } from './modpacksch';
import * as official from './curseforge-official';
import { CurseforgeAuthError } from './curseforge-official';
import { curseforgeKeyConfigured, curseforgeKeyValid, markCurseforgeKeyInvalid } from '../curseforge';
import type { FilterGroup, ModProvider, ProjectVersion, SearchHit, SearchQuery } from './types';

/**
 * Metadata (search, browse, project details, description, changelog) comes
 * from CurseForge's own API once a key is configured and has tested as
 * working; a call that comes back as an outright auth rejection (401/403)
 * flips the stored "valid" flag off immediately, so the very next call skips
 * the official API instead of failing again. Anything else - no key, a key
 * that has not been tested as working, a network hiccup, the official API
 * being down - falls back to the modpacks.ch mirror for that one call only.
 *
 * The actual install-time file list for a picked modpack version always
 * comes from the mirror regardless of key state - see the comment at the
 * top of ./curseforge-official.ts for why.
 */

async function withFallback<T>(useOfficial: boolean, run: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
	if (!useOfficial) return fallback();
	try {
		return await run();
	} catch (err) {
		if (err instanceof CurseforgeAuthError) markCurseforgeKeyInvalid();
		return fallback();
	}
}

export const curseforgeProvider: ModProvider = {
	id: 'curseforge',
	label: 'CurseForge',
	available: () => true,
	unavailableReason: () =>
		curseforgeKeyConfigured() && !curseforgeKeyValid()
			? 'A CurseForge API key is set but has not tested as working, so browsing falls back to the public modpacks.ch mirror. Check it on the Settings page.'
			: 'Browsing, filtering, and search work without a key through the public modpacks.ch mirror. Add a CurseForge API key on the Settings page for the official search and a real changelog.',

	async search(query: SearchQuery): Promise<SearchHit[]> {
		return withFallback(curseforgeKeyValid(), () => official.search(query), () => mirrorProvider.search(query));
	},

	async getProject(id: string): Promise<SearchHit> {
		return withFallback(
			curseforgeKeyValid(),
			() => official.getProject(id),
			() => mirrorProvider.getProject(id)
		);
	},

	async description(id: string): Promise<string | null> {
		return withFallback(
			curseforgeKeyValid(),
			() => official.description(id),
			() => mirrorProvider.description!(id)
		);
	},

	async listVersions(
		id: string,
		filter?: { minecraftVersion?: string; loader?: string }
	): Promise<ProjectVersion[]> {
		return withFallback(
			curseforgeKeyValid(),
			() => official.listVersions(id, filter),
			() => mirrorProvider.listVersions(id, filter)
		);
	},

	async getVersion(projectId: string, versionId: string): Promise<ProjectVersion> {
		// The file list is always the mirror's - only metadata + changelog
		// come from the official API - so both are needed either way.
		const fromMirror = mirrorProvider.getVersion(projectId, versionId);
		if (!curseforgeKeyValid()) return fromMirror;

		try {
			const metadata = await official.getVersion(projectId, versionId);
			const mirrored = await fromMirror;
			// The official file tags list every compatible game version in no
			// useful order (MeatballCraft: "1.12" before "1.12.2") and carry no
			// loader build; the mirror's targets are the exact install target.
			return {
				...metadata,
				files: mirrored.files,
				gameVersions: mirrored.gameVersions.length ? mirrored.gameVersions : metadata.gameVersions,
				loaders: mirrored.loaders.length ? mirrored.loaders : metadata.loaders,
				loaderVersions: mirrored.loaderVersions
			};
		} catch (err) {
			if (err instanceof CurseforgeAuthError) markCurseforgeKeyInvalid();
			return fromMirror;
		}
	},

	async filterGroups(kind: 'mod' | 'modpack'): Promise<FilterGroup[]> {
		return withFallback(
			curseforgeKeyValid(),
			() => official.filterGroups(kind),
			() => mirrorProvider.filterGroups!(kind)
		);
	}
};

/**
 * Single mods. Files always come from the mirror: the official API's
 * downloadUrl is null for every project that opted out of third-party
 * downloads, and its file list ignores the loader. With a working key the
 * official search (real paging and filters) and changelogs are used, with
 * the numeric id as slug so both paths store the same mod the same way.
 */
export const curseforgeModProvider: ModProvider = {
	...mirrorModProvider,

	async search(query: SearchQuery): Promise<SearchHit[]> {
		return withFallback(
			curseforgeKeyValid(),
			async () => (await official.search({ ...query, kind: 'mod' })).map((hit) => ({ ...hit, slug: hit.id })),
			() => mirrorModProvider.search(query)
		);
	},

	async getVersion(projectId, versionId, context): Promise<ProjectVersion> {
		const version = await mirrorModProvider.getVersion(projectId, versionId, context);
		if (!curseforgeKeyValid()) return version;
		return { ...version, changelog: await official.fetchChangelog(projectId, versionId) };
	}
};
