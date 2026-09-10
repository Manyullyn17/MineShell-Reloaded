import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProvider } from '$lib/server/mods';
import { projectBody } from '$lib/server/mods/modrinth';
import { packDescription } from '$lib/server/mods/modpacksch';

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
	if (!projectId) error(400, 'A project id is required.');

	try {
		const provider = getProvider(source);
		const project = await provider.getProject(projectId);

		let description: string | null = null;
		let changelog: string | null = null;

		if (source === 'modrinth') {
			description = await projectBody(projectId);
		} else {
			description = await packDescription(source === 'ftb' ? 'ftb' : 'curseforge', projectId);
		}

		// CurseForge and FTB's version-detail responses both carry the
		// changelog inline (confirmed in the API spec) - same call every
		// source needs anyway for gameVersions/loaders, so one getVersion()
		// covers it instead of a second changelog-specific request.
		if (versionId) {
			const version = await provider.getVersion(projectId, versionId);
			changelog = version.changelog?.trim() || null;
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
