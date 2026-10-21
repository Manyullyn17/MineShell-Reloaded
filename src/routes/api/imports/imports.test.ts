import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { POST, PUT } from './+server';
import { POLICY } from '#lib/server/access/policy.js';
import { IMPORT_DIR, MANIFEST } from '#lib/server/serverbundle.js';
import { zipBuffer } from '../../../../tests/helpers/fs';
import { call } from '../../../../tests/helpers/routes';

/**
 * The New server page's import: an export uploaded raw into tmp/imports, or
 * one already on this machine named by its path (the owner's only: it reads
 * any file MineShell can).
 */

const EXPORT = zipBuffer({ [MANIFEST]: JSON.stringify({ format: 1, server: { name: 'Moved', minecraftVersion: '1.21.1', modloader: 'fabric' } }) });

const uploads = async () => (await fs.readdir(IMPORT_DIR()).catch(() => [])).sort();

async function upload(bytes: Uint8Array, name: string | null, { breaksOff = false } = {}) {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			if (breaksOff) controller.error(new Error('connection reset'));
			else controller.close();
		}
	});
	const query = name === null ? '' : `?name=${encodeURIComponent(name)}`;
	const response = await call(PUT, { method: 'PUT', url: `http://localhost/api/imports${query}`, body });
	return { status: response.status, body: (await response.json()) as { message?: string; fileName?: string; name?: string } };
}

const byPath = async (json: unknown) => {
	const response = await call(POST, { method: 'POST', url: 'http://localhost/api/imports', json });
	return { status: response.status, body: (await response.json()) as { message?: string; fileName?: string } };
};

describe('importing a server export', () => {
	it('takes an upload from anyone who may add servers, a path on this machine from the owner only', () => {
		expect(POLICY['/api/imports']).toEqual({ methods: { PUT: 'create', POST: 'owner' } });
	});

	it("keeps only the file's own name from the name it is sent with", async () => {
		expect(await upload(new Uint8Array(EXPORT), '../../../etc/cron.d/x.zip')).toMatchObject({ status: 200, body: { fileName: 'x.zip', name: 'Moved' } });
		expect(await upload(new Uint8Array(EXPORT), null)).toMatchObject({ status: 200, body: { fileName: 'export.zip' } });
	});

	it('leaves no upload behind when it is not an export or breaks off', async () => {
		const before = await uploads();
		expect(await upload(new TextEncoder().encode('not a zip'), 'a.zip')).toMatchObject({ status: 400, body: { message: 'That file is not a readable zip.' } });
		expect(await upload(new Uint8Array(zipBuffer({ 'readme.txt': 'hi' })), 'b.zip')).toMatchObject({ status: 400 });
		expect(await upload(new Uint8Array(EXPORT), 'c.zip', { breaksOff: true })).toEqual({ status: 400, body: { message: 'The upload did not finish.' } });
		expect(await uploads()).toEqual(before);
	});

	it('takes a path only as a full path to a file, and leaves that file where it is', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-import-'));
		const file = path.join(dir, `export-${crypto.randomUUID()}.zip`);
		await fs.writeFile(file, EXPORT);
		try {
			expect(await byPath({ path: path.relative(process.cwd(), file) })).toMatchObject({ status: 400, body: { message: expect.stringMatching(/^Give the full path/) } });
			expect(await byPath({ path: dir })).toMatchObject({ status: 400, body: { message: `There is no file at ${dir}.` } });
			expect(await byPath({ path: `${dir}/missing.zip` })).toMatchObject({ status: 400 });
			expect(await byPath({ path: 42 })).toMatchObject({ status: 400 });
			expect(await byPath({ path: file })).toMatchObject({ status: 200, body: { fileName: path.basename(file) } });
			expect(await fs.readFile(file)).toEqual(EXPORT);
			// Not an export: refused, and still not MineShell's to delete.
			const other = path.join(dir, 'notes.txt');
			await fs.writeFile(other, 'mine');
			expect(await byPath({ path: other })).toMatchObject({ status: 400 });
			expect(await fs.readFile(other, 'utf8')).toBe('mine');
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
