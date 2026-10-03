import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getModProvider, getProvider } from '$lib/server/mods';

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
		const project = await provider.getProject(projectId);

		const description = (await provider.description?.(projectId)) ?? null;
		let changelog: string | null = null;

		// Every provider's getVersion() already carries the changelog (a
		// second, changelog-only request for the version this app already
		// needs for gameVersions/loaders would be redundant).
		// A version the source cannot look up by id alone (an older CurseForge
		// mod file) just shows no changelog rather than failing the description.
		if (versionId) {
			const version = await provider.getVersion(projectId, versionId).catch(() => null);
			changelog = version?.changelog?.trim() || null;
		}

		return json({
			name: project.name,
			author: project.author,
			projectUrl: project.projectUrl,
			summary: project.summary,
			description,
			changelog
		});
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Lookup failed.');
	}
};
