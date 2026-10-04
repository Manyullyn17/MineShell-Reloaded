import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getModProvider, getProvider } from '#lib/server/mods/index.js';

/** The filter groups a browse sidebar should render for one source and kind. */
export const GET: RequestHandler = async ({ url }) => {
	const source = url.searchParams.get('source') ?? 'modrinth';
	const kind = url.searchParams.get('kind') === 'modpack' ? 'modpack' : 'mod';

	try {
		const provider = kind === 'mod' ? getModProvider(source) : getProvider(source);
		const groups = (await provider.filterGroups?.(kind)) ?? [];
		return json({ groups });
	} catch (err) {
		error(502, err instanceof Error ? err.message : 'Could not load filters.');
	}
};
