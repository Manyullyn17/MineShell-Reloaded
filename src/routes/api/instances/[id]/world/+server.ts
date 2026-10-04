import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getInstance, InstanceError, requireStopped } from '#lib/server/instances.js';
import { TMP_DIR } from '#lib/server/config.js';
import { decideSnapshot, SnapshotChoiceNeeded } from '#lib/server/snapshots.js';
import { downloadWorld, replaceWorld } from '#lib/server/world.js';

/** The world (or `?snapshot=<id>`) as a zip, streamed while it is built. */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	try {
		const { stream, fileName } = await downloadWorld(instance, url.searchParams.get('snapshot'));
		return new Response(Readable.toWeb(stream) as ReadableStream, {
			headers: {
				'Content-Type': 'application/zip',
				'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`
			}
		});
	} catch (err) {
		if (err instanceof InstanceError) error(409, err.message);
		throw err;
	}
};

/**
 * Replace the world with the zip in the request body, sent raw rather than
 * as a form: a form body is buffered whole in memory, and worlds run to
 * gigabytes. `?snapshot=yes|no` answers the snapshot question.
 */
export const PUT: RequestHandler = async ({ params, url, request, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	if (!request.body) error(400, 'No file was sent.');
	let snapshot: boolean;
	try {
		// Refused before the upload is read, not after gigabytes of it.
		await requireStopped(instance);
		snapshot = await decideSnapshot(instance, url.searchParams.get('snapshot'), { moves: true });
	} catch (err) {
		if (err instanceof InstanceError || err instanceof SnapshotChoiceNeeded) return Response.json({ message: err.message }, { status: 400 });
		throw err;
	}

	await fs.mkdir(TMP_DIR, { recursive: true });
	const file = path.join(TMP_DIR, `world-upload-${crypto.randomUUID()}.zip`);
	try {
		await pipeline(Readable.fromWeb(request.body as import('node:stream/web').ReadableStream), createWriteStream(file));
	} catch {
		await fs.rm(file, { force: true });
		return Response.json({ message: 'The upload did not finish.' }, { status: 400 });
	}
	try {
		return Response.json({ taskId: await replaceWorld(instance, file, { snapshot }) });
	} catch (err) {
		if (err instanceof InstanceError) return Response.json({ message: err.message }, { status: 400 });
		throw err;
	}
};
