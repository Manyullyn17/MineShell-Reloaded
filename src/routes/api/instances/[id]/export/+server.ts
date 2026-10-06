import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { exportResult } from '#lib/server/packexport.js';

/** A finished client pack export (`?task=<id>`), kept for an hour after it is built. */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const result = exportResult(params.id, url.searchParams.get('task') ?? '');
	const stat = result && (await fs.stat(result.file).catch(() => null));
	if (!result || !stat) error(404, 'That export is gone; build it again.');
	return new Response(Readable.toWeb(createReadStream(result.file)) as ReadableStream, {
		headers: {
			'Content-Type': 'application/zip',
			'Content-Length': String(stat.size),
			'Content-Disposition': `attachment; filename="${encodeURIComponent(result.fileName)}"`
		}
	});
};
