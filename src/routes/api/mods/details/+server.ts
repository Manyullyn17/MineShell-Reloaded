import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cachedDetails } from '#lib/server/mods/catalogcache.js';
import { getModProvider, getProvider } from '#lib/server/mods/index.js';

/**
 * Full description and changelog for one project/version.
 *
 * Separate from search and version listing because both are large and only
 * wanted once the user asks to read them, not for every row in a list.
 *
 * Both fields come back as raw markdown text. MineShell renders them as plain
 * text rather than parsed HTML: these are third-party strings, and rendering
 * them as markup would mean taking on a parser and a sanitiser to avoid
 * injecting arbitrary HTML into the page. The project link covers the rich
 * version.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');

	const source = url.searchParams.get('source') ?? 'modrinth';
	const projectId = url.searchParams.get('id');
	const versionId = url.searchParams.get('versionId');
	const kind = url.searchParams.get('kind') === 'modpack' ? 'modpack' : 'mod';
	if (!projectId) error(400, 'A project id is required.');

	try {
		const provider = kind === 'mod' ? getModProvider(source) : getProvider(source);
		const { project, description } = await cachedDetails(source, kind, projectId, null, async () => ({
			project: await provider.getProject(projectId),
			description: (await provider.description?.(projectId)) ?? null
		}));

		// Every provider's getVersion() already carries the changelog (a
		// second, changelog-only request for the version this app already
		// needs for gameVersions/loaders would be redundant).
		// A version the source cannot look up by id alone (an older CurseForge
		// mod file) just shows no changelog rather than failing the description,
		// and that failure stays out of the cache: it is thrown through it.
		const changelog = versionId
			? await cachedDetails(source, kind, projectId, versionId, async () => (await provider.getVersion(projectId, versionId)).changelog?.trim() || null).catch(() => null)
			: null;

		return Response.json({
			name: project.name,
			author: project.author,
			projectUrl: project.projectUrl,
			summary: project.summary,
			updatedAt: project.updatedAt ?? null,
			license: project.license ?? null,
			description,
			changelog
		});
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Lookup failed.');
	}
};
