import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { bestVersion, getModProvider, listInstanceMods } from '#lib/server/mods/index.js';
import { getInstance } from '#lib/server/instances.js';

/**
 * Resolves one version's dependencies into named, installable entries.
 *
 * This is deliberately separate from /api/mods/versions: the version list
 * carries raw dependency ids only, and resolving names there would mean a
 * lookup per dependency per version - dozens of API calls to render a
 * dropdown. Here it runs once, for the single version the user actually
 * picked.
 */
export const GET: RequestHandler = async ({ url }) => {
	const source = url.searchParams.get('source') ?? 'modrinth';
	const projectId = url.searchParams.get('id');
	const versionId = url.searchParams.get('versionId');
	const mc = url.searchParams.get('mc') || undefined;
	const loader = url.searchParams.get('loader') || undefined;
	const instanceId = url.searchParams.get('instance');

	if (!projectId || !versionId) error(400, 'A project id and version id are required.');

	// What the instance already has, so a dependency that is present is shown as
	// such instead of being offered for a pointless reinstall.
	const installedSlugs = new Set<string>();
	if (instanceId) {
		const instance = getInstance(instanceId);
		if (instance) {
			for (const mod of await listInstanceMods(instance)) {
				if (mod.slug) installedSlugs.add(mod.slug.toLowerCase());
			}
		}
	}

	try {
		const provider = getModProvider(source);
		const version = await provider.getVersion(projectId, versionId, { minecraftVersion: mc });

		const relevant = version.dependencies.filter(
			(d) => (d.type === 'required' || d.type === 'optional') && d.projectId
		);

		const resolved = await Promise.all(
			relevant.map(async (dep) => {
				try {
					const project = await provider.getProject(dep.projectId!);
					// Pick the version to install: the pinned one if the dependency
					// names it, otherwise the newest matching this instance.
					let pinnedVersionId = dep.versionId;
					if (!pinnedVersionId) {
						const candidates = await provider.listVersions(dep.projectId!, {
							minecraftVersion: mc,
							loader
						});
						pinnedVersionId = bestVersion(candidates)?.id ?? null;
					}
					const alreadyInstalled = installedSlugs.has(project.slug.toLowerCase());
					return {
						projectId: dep.projectId,
						versionId: pinnedVersionId,
						type: dep.type,
						name: project.name,
						summary: project.summary,
						iconUrl: project.iconUrl,
						alreadyInstalled,
						// Nothing to install if no compatible version exists; the UI
						// shows this rather than silently skipping it.
						installable: Boolean(pinnedVersionId) && !alreadyInstalled
					};
				} catch {
					return {
						projectId: dep.projectId,
						versionId: null,
						type: dep.type,
						name: dep.name ?? 'Unknown dependency',
						summary: null,
						iconUrl: null,
						alreadyInstalled: false,
						installable: false
					};
				}
			})
		);

		return Response.json({ dependencies: resolved });
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Dependency lookup failed.');
	}
};
