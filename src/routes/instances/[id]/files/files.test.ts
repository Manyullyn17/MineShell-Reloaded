import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { actions } from './+page.server';
import { createInstance } from '../../../../../tests/helpers/instances';
import { ls } from '../../../../../tests/helpers/fs';
import { post } from '../../../../../tests/helpers/routes';

/**
 * The Files tab reaches anything in a server folder, for anyone given file
 * access to that one server: every path it is posted must stay inside it.
 */

async function server() {
	const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' }, { 'mods/a.jar': 'jar', 'config/x.toml': 'x = 1\n' });
	// A neighbour whose name starts with the server's: a prefix check alone would let it through.
	const neighbour = `${instance.path}-other`;
	await fs.mkdir(neighbour, { recursive: true });
	await fs.writeFile(path.join(neighbour, 'keep.txt'), 'keep');
	return { instance, neighbour, params: { id: instance.id } };
}

const refused = { status: 400, data: { ok: false, message: 'That path is outside the instance directory.' } };

describe('the Files tab stays inside the server folder', () => {
	it('refuses saves, folders, uploads and renames that point outside', async () => {
		const { instance, neighbour, params } = await server();
		const name = path.basename(neighbour);
		expect(await post(actions.save, { params, fields: { path: `../${name}/keep.txt`, contents: 'gone' } })).toMatchObject(refused);
		expect(await post(actions.mkdir, { params, fields: { dir: '../..', name: 'made' } })).toMatchObject(refused);
		expect(await post(actions.rename, { params, fields: { from: 'mods/a.jar', to: `../../${name}/a.jar` } })).toMatchObject(refused);
		expect(await post(actions.rename, { params, fields: { from: `../${name}/keep.txt`, to: 'stolen.txt' } })).toMatchObject(refused);
		const file = new File(['x'], 'evil.txt');
		expect(await post(actions.upload, { params, fields: { dir: `../${name}`, files: file } })).toMatchObject(refused);
		// A dropped folder's file names carry folders; they cannot step out either.
		const climbing = new File(['x'], `../../${name}/evil.txt`);
		expect(await post(actions.upload, { params, fields: { dir: '', withFolders: '1', files: climbing } })).toMatchObject({ status: 400 });

		expect(await fs.readFile(path.join(neighbour, 'keep.txt'), 'utf8')).toBe('keep');
		expect(await ls(neighbour)).toEqual(['keep.txt']);
		expect(await fs.readFile(path.join(instance.path, 'mods/a.jar'), 'utf8')).toBe('jar');
	});

	it('reads a leading slash as the server folder, not the machine root', async () => {
		const { instance, params } = await server();
		expect(await post(actions.save, { params, fields: { path: '/config/x.toml', contents: 'x = 2\n' } })).toMatchObject({ ok: true });
		expect(await fs.readFile(path.join(instance.path, 'config/x.toml'), 'utf8')).toBe('x = 2\n');
	});

	it("keeps a file's line endings, though forms send every newline as CRLF", async () => {
		const { instance, params } = await server();
		await fs.writeFile(path.join(instance.path, 'run.sh'), '#!/bin/sh\njava -jar server.jar\n');
		await fs.writeFile(path.join(instance.path, 'windows.cfg'), 'a=1\r\nb=2\r\n');
		expect(await post(actions.save, { params, fields: { path: 'run.sh', contents: '#!/bin/sh\njava -Xmx2G -jar server.jar\n' } })).toMatchObject({ ok: true });
		expect(await post(actions.save, { params, fields: { path: 'windows.cfg', contents: 'a=1\nb=3\n' } })).toMatchObject({ ok: true });
		expect(await post(actions.save, { params, fields: { path: 'new.txt', contents: 'one\ntwo\n' } })).toMatchObject({ ok: true });
		expect(await fs.readFile(path.join(instance.path, 'run.sh'), 'utf8')).toBe('#!/bin/sh\njava -Xmx2G -jar server.jar\n');
		expect(await fs.readFile(path.join(instance.path, 'windows.cfg'), 'utf8')).toBe('a=1\r\nb=3\r\n');
		expect(await fs.readFile(path.join(instance.path, 'new.txt'), 'utf8')).toBe('one\ntwo\n');
	});

	it('never deletes the server folder itself or something outside it', async () => {
		const { instance, neighbour, params } = await server();
		for (const target of ['', '.', '/', 'mods/..']) {
			expect(await post(actions.delete, { params, fields: { path: target } })).toMatchObject({ status: 400 });
		}
		expect(await post(actions.delete, { params, fields: { path: `../${path.basename(neighbour)}` } })).toMatchObject(refused);
		expect(await ls(neighbour)).toEqual(['keep.txt']);
		expect(await ls(path.join(instance.path, 'mods'))).toEqual(['a.jar']);
	});

	it('takes only trash ids it made, so restore and purge cannot name another folder', async () => {
		const { instance, params } = await server();
		for (const id of ['../mods', '../../', '1-ab/../../mods']) {
			expect(await post(actions.purge, { params, fields: { id } })).toMatchObject({ status: 400 });
			expect(await post(actions.restore, { params, fields: { id } })).toMatchObject({ status: 400 });
		}
		expect(await ls(path.join(instance.path, 'mods'))).toEqual(['a.jar']);

		// A real delete goes to the trash and comes back.
		const deleted = (await post(actions.delete, { params, fields: { path: 'config/x.toml' } })) as { undo: string };
		await expect(fs.access(path.join(instance.path, 'config/x.toml'))).rejects.toThrow();
		expect(await post(actions.restore, { params, fields: { id: deleted.undo } })).toMatchObject({ ok: true });
		expect(await fs.readFile(path.join(instance.path, 'config/x.toml'), 'utf8')).toBe('x = 1\n');
	});
});
