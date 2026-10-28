import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '#lib/server/instances.js';
import { readVersion } from '#lib/server/filehistory.js';

/** One earlier version of an edited file, as text, for the editor to load (filehistory.ts). */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	try {
		const text = await readVersion(instance.path, url.searchParams.get('path') ?? '', url.searchParams.get('version') ?? '');
		return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
	} catch {
		error(404, 'No such version.');
	}
};
