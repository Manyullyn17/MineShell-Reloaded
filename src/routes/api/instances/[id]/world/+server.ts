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
import { downloadWorld, replaceWorld, worldFromZip } from '#lib/server/world.js';

/** The world (or `?snapshot=<id>`, or another world: `?world=<folder>`) as a zip, streamed while it is built. */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	try {
		const { stream, fileName } = await downloadWorld(instance, url.searchParams.get('snapshot'), url.searchParams.get('world'));
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
 * gigabytes. `?snapshot=yes|no` answers the snapshot question. With
 * `?newWorld=<name>` the zip becomes a new world beside the others instead,
 * which needs no stopped server and no snapshot; `&activate=1` (stopped
 * servers only) makes it the active one, `&keepMap=1` keeping the old map.
 */
export const PUT: RequestHandler = async ({ params, url, request, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');
	if (!request.body) error(400, 'No file was sent.');
	const newWorld = url.searchParams.get('newWorld');
	let snapshot = false;
	try {
		// Refused before the upload is read, not after gigabytes of it.
		if (newWorld === null) {
			await requireStopped(instance);
			snapshot = await decideSnapshot(instance, url.searchParams.get('snapshot'), { moves: true });
		} else if (!newWorld.trim()) {
			throw new InstanceError('Give the world a name.');
		} else if (url.searchParams.get('activate') === '1') {
			await requireStopped(instance);
		}
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
		if (newWorld !== null) {
			const activate = url.searchParams.get('activate') === '1' ? { keepMap: url.searchParams.get('keepMap') === '1' } : undefined;
			return Response.json({ taskId: (await worldFromZip(instance, file, newWorld, { activate })).taskId });
		}
		return Response.json({ taskId: await replaceWorld(instance, file, { snapshot }) });
	} catch (err) {
		if (err instanceof InstanceError) return Response.json({ message: err.message }, { status: 400 });
		throw err;
	}
};
