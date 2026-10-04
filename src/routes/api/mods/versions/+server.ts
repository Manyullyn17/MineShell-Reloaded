import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { compareVersionPriority, getModProvider } from '$lib/server/mods';
import { isDatapackVersion } from '$lib/server/mods/datapacks';

export const GET: RequestHandler = async ({ url }) => {
	const source = url.searchParams.get('source') ?? 'modrinth';
	const id = url.searchParams.get('id');
	if (!id) error(400, 'A project id is required.');

	try {
		const provider = getModProvider(source);
		const loader = url.searchParams.get('loader') || 'vanilla';
		const versions = await provider.listVersions(id, {
			minecraftVersion: url.searchParams.get('mc') || undefined,
			loader,
			// Modrinth lists data pack releases; they install into the world instead.
			includeDatapacks: provider.id === 'modrinth'
		});
		// Release first, then beta, then alpha, newest within each - so the
		// default selection (the top of the list) is never an old prerelease.
		versions.sort(compareVersionPriority);
		// On a modded server the mod is what people usually want; a project that
		// publishes both (Terralith) lists its data pack releases after.
		if (loader !== 'vanilla') {
			versions.sort((a, b) => Number(isDatapackVersion(a, loader)) - Number(isDatapackVersion(b, loader)));
		}
		return json({
			versions: versions.slice(0, 40).map((v) => ({
				id: v.id,
				versionNumber: v.versionNumber,
				channel: v.channel,
				datePublished: v.datePublished,
				clientOnly: v.clientOnly ?? false,
				datapack: isDatapackVersion(v, loader),
				dependencies: v.dependencies.filter((d) => d.type === 'required' || d.type === 'optional')
			}))
		});
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Version lookup failed.');
	}
};
