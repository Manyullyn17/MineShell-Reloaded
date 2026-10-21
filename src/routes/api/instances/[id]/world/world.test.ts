import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { PUT } from './+server';
import { TMP_DIR } from '#lib/server/config.js';
import { invalidateUnitState } from '#lib/server/systemd.js';
import { createInstance, systemdStopped } from '../../../../../../tests/helpers/instances';
import { zipBuffer } from '../../../../../../tests/helpers/fs';
import { fakeProcesses, resetProcesses } from '../../../../../../tests/helpers/process';
import { call } from '../../../../../../tests/helpers/routes';

afterEach(resetProcesses);

/**
 * World uploads arrive raw (they run to gigabytes) and are written to tmp/
 * before anything reads them: a refusal that can be made first is made before
 * the upload is read, and an upload refused or broken off leaves nothing there.
 */

/** A request body that notes whether it was read, and can break off halfway. */
function upload(bytes: Uint8Array, { breaksOff = false } = {}) {
	const read = { started: false };
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				read.started = true;
				controller.enqueue(bytes);
				if (breaksOff) controller.error(new Error('connection reset'));
				else controller.close();
			}
		},
		{ highWaterMark: 0 }
	);
	return { body, read };
}

const leftovers = async () => (await fs.readdir(TMP_DIR).catch(() => [])).filter((name) => name.startsWith('world-upload-'));

function running() {
	invalidateUnitState();
	fakeProcesses((cmd, args) => (args.includes('show') ? { stdout: 'ActiveState=active\nSubState=running\n' } : {}));
}

const server = () => createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' }, { 'world/level.dat': 'level' });

async function put(id: string, query: string, bytes: Uint8Array, opts: { breaksOff?: boolean } = {}) {
	const { body, read } = upload(bytes, opts);
	const response = await call(PUT, { method: 'PUT', params: { id }, url: `http://localhost/api/instances/${id}/world${query}`, body });
	return { status: response.status, message: ((await response.json()) as { message?: string }).message, read: read.started };
}

describe('uploading a world', () => {
	it('refuses before reading the upload: a running server, a blank new world name, making a new world active while running', async () => {
		const instance = await server();
		const before = await leftovers();
		running();
		expect(await put(instance.id, '?snapshot=no', new Uint8Array(8))).toEqual({ status: 400, message: 'Stop the server first.', read: false });
		expect(await put(instance.id, '?newWorld=world2&activate=1', new Uint8Array(8))).toMatchObject({ status: 400, read: false });
		systemdStopped();
		expect(await put(instance.id, '?newWorld=%20%20', new Uint8Array(8))).toEqual({ status: 400, message: 'Give the world a name.', read: false });
		expect(await leftovers()).toEqual(before);
	});

	it('leaves nothing behind when the upload breaks off', async () => {
		systemdStopped();
		const instance = await server();
		const before = await leftovers();
		expect(await put(instance.id, '?snapshot=no', new Uint8Array(64), { breaksOff: true })).toEqual({
			status: 400,
			message: 'The upload did not finish.',
			read: true
		});
		expect(await leftovers()).toEqual(before);
	});

	it('leaves nothing behind when the file is not a world', async () => {
		systemdStopped();
		const instance = await server();
		const before = await leftovers();
		const notAZip = new TextEncoder().encode('not a zip at all');
		expect(await put(instance.id, '?snapshot=no', notAZip)).toMatchObject({ status: 400, message: 'That file is not a readable zip.' });
		expect(await put(instance.id, '?newWorld=other', notAZip)).toMatchObject({ status: 400, message: 'That file is not a readable zip.' });
		const noWorld = new Uint8Array(zipBuffer({ 'readme.txt': 'hi' }));
		expect(await put(instance.id, '?snapshot=no', noWorld)).toMatchObject({ status: 400, message: expect.stringMatching(/^There is no level.dat/) });
		expect(await leftovers()).toEqual(before);
		expect(await fs.readFile(`${instance.path}/world/level.dat`, 'utf8')).toBe('level');
	});
});
