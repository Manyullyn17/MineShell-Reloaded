import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getInstance } from '$lib/server/instances';
import { fileStream, statFile } from '$lib/server/files';
import { Readable } from 'node:stream';
import path from 'node:path';

/** Streams a file out of an instance directory as a download. */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');

	const relative = url.searchParams.get('path');
	if (!relative) error(400, 'A path is required.');

	try {
		const stat = await statFile(instance.path, relative);
		if (stat.isDirectory()) error(400, 'That is a folder.');

		const stream = Readable.toWeb(
			fileStream(instance.path, relative)
		) as ReadableStream;

		return new Response(stream, {
			headers: {
				'Content-Type': 'application/octet-stream',
				'Content-Length': String(stat.size),
				'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(relative))}"`
			}
		});
	} catch (err) {
		if ((err as { status?: number }).status) throw err;
		error(404, 'No such file.');
	}
};
