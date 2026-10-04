import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance, InstanceError } from '#lib/server/instances.js';
import { listModVersions, previewDependencies } from '#lib/server/modupdates.js';

/**
 * The versions one installed mod can switch to, older ones included; with
 * `versionId`, the dependencies switching to that one would install.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	try {
		const fileName = url.searchParams.get('fileName') ?? '';
		const versionId = url.searchParams.get('versionId');
		if (versionId) return Response.json({ dependencies: await previewDependencies(instance, fileName, versionId) });
		return Response.json(await listModVersions(instance, fileName));
	} catch (err) {
		const status = err instanceof InstanceError ? 400 : 502;
		return Response.json({ message: err instanceof Error ? err.message : 'Looking up versions failed.' }, { status });
	}
};
