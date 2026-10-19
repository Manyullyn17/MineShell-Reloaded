import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { InstanceError } from '#lib/server/instances.js';
import { IMPORT_DIR, stageImport } from '#lib/server/serverbundle.js';

/**
 * A MineShell server export for the New server page's import: the file in the
 * request body, sent raw (exports run to gigabytes, and a form body is
 * buffered whole); its name in `?name=`. Answers what the export holds, and
 * the id the import action takes.
 */
export const PUT: RequestHandler = async ({ url, request, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	if (!request.body) error(400, 'No file was sent.');
	await fs.mkdir(IMPORT_DIR(), { recursive: true });
	const file = path.join(IMPORT_DIR(), `${crypto.randomUUID()}.zip`);
	try {
		await pipeline(Readable.fromWeb(request.body as import('node:stream/web').ReadableStream), createWriteStream(file));
	} catch {
		await fs.rm(file, { force: true });
		return Response.json({ message: 'The upload did not finish.' }, { status: 400 });
	}
	const name = path.basename(url.searchParams.get('name') ?? '') || 'export.zip';
	try {
		return Response.json(await stageImport(file, name, true));
	} catch (err) {
		if (err instanceof InstanceError) return Response.json({ message: err.message }, { status: 400 });
		throw err;
	}
};

/**
 * An export already on this machine (copied over with scp, say), by its full
 * path in `{ path }`; the owner's only, since it reads any file MineShell can.
 * The file stays where it is.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.authenticated) error(401, 'Not signed in.');
	const body = (await request.json().catch(() => null)) as { path?: unknown } | null;
	const file = typeof body?.path === 'string' ? body.path.trim() : '';
	if (!path.isAbsolute(file)) return Response.json({ message: 'Give the full path of the file, starting with /.' }, { status: 400 });
	const stat = await fs.stat(file).catch(() => null);
	if (!stat?.isFile()) return Response.json({ message: `There is no file at ${file}.` }, { status: 400 });
	try {
		return Response.json(await stageImport(file, path.basename(file), false));
	} catch (err) {
		if (err instanceof InstanceError) return Response.json({ message: err.message }, { status: 400 });
		throw err;
	}
};
