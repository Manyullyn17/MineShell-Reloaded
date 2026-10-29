import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Zips in Files (filezips.ts): a folder downloaded as a zip, an uploaded zip unpacked. */

const rcon = vi.hoisted(() => ({ commands: [] as string[], running: false }));
vi.mock('#lib/server/rcon.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/rcon.js')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		rcon.commands.push(...commands);
		return commands.map(() => '');
	})
}));
// Only `running` is read from it.
vi.mock('#lib/server/instances.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/instances.js')>()),
	summarise: vi.fn(async () => ({ running: rcon.running }))
}));

const { planUnpack, unpackZip, UnpackConflict, zipFolder } = await import('#lib/server/filezips.js');
const { openZipBuffer } = await import('#lib/server/zip.js');
const { listTrash } = await import('#lib/server/trash.js');
const { encryptSecret } = await import('#lib/server/crypto.js');
const { createInstance } = await import('../helpers/instances');
const { zipBuffer } = await import('../helpers/fs');

const server = (files: Record<string, string | Buffer> = {}) =>
	createInstance(
		{ modloader: 'fabric', minecraftVersion: '1.21.1', rconPasswordEnc: encryptSecret('pw') },
		{ 'config/a.toml': 'a = 1\n', 'world/level.dat': 'level', 'world/session.lock': 'lock', ...files }
	);

async function zipNames(stream: Readable): Promise<string[]> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(chunk as Buffer);
	return openZipBuffer(Buffer.concat(chunks))!.entries.map((e) => e.name).sort();
}

const read = (root: string, rel: string) => fs.readFile(path.join(root, rel), 'utf8');

beforeEach(() => {
	rcon.commands = [];
	rcon.running = false;
});

describe('a folder downloaded as a zip', () => {
	it('names entries from inside the folder, and the zip after it', async () => {
		const instance = await server({ 'config/sub/b.json': '{}' });
		const { stream, fileName } = await zipFolder(instance, 'config');
		expect(fileName).toBe('config.zip');
		expect(await zipNames(stream)).toEqual(['a.toml', 'sub/b.json']);
	});

	it('leaves out what a server copy leaves out, and the world lock', async () => {
		const instance = await server({ '.mineshell/snapshots/1/world/level.dat': 'old', '.mineshell/trash/x/y': 'gone', '.mineshell/keep.json': '{}' });
		const { stream, fileName } = await zipFolder(instance, '');
		expect(fileName).toBe(`${instance.id}.zip`);
		const names = await zipNames(stream);
		expect(names).toContain('.mineshell/keep.json');
		expect(names).toContain('world/level.dat');
		expect(names.filter((n) => n.includes('snapshots') || n.includes('trash') || n.endsWith('session.lock'))).toEqual([]);
	});

	it('pauses saving of a running server while its world is zipped, and only then', async () => {
		const instance = await server();
		rcon.running = true;
		await zipNames((await zipFolder(instance, 'config')).stream);
		expect(rcon.commands).toEqual([]);
		await zipNames((await zipFolder(instance, 'world')).stream);
		await vi.waitFor(() => expect(rcon.commands).toEqual(['save-off', 'save-all flush', 'save-on']));
	});

	it('refuses a path outside the server folder', async () => {
		const instance = await server();
		await expect(zipFolder(instance, '../')).rejects.toThrow(/outside/);
	});
});

describe('unpacking a zip', () => {
	it('unpacks where it lies, or into a folder named after it', async () => {
		const instance = await server({ 'kubejs/pack.zip': zipBuffer({ 'scripts/a.js': 'one', 'b.txt': 'two' }) });
		expect(await unpackZip(instance, 'kubejs/pack.zip', 'here', { replace: false })).toEqual({ target: 'kubejs', files: 2, replaced: 0 });
		expect(await read(instance.path, 'kubejs/scripts/a.js')).toBe('one');
		await unpackZip(instance, 'kubejs/pack.zip', 'folder', { replace: false });
		expect(await read(instance.path, 'kubejs/pack/b.txt')).toBe('two');
	});

	it('does not nest a folder the zip already holds under the same name', async () => {
		const instance = await server({ 'pack.zip': zipBuffer({ 'pack/': '', 'pack/a.txt': 'a' }) });
		const plan = await planUnpack(instance.path, 'pack.zip', 'folder');
		expect(plan.entries.map((e) => e.out)).toEqual(['pack/a.txt']);
	});

	it('asks before replacing, then puts what it replaced in the trash', async () => {
		const instance = await server({ 'cfg.zip': zipBuffer({ 'config/a.toml': 'a = 2\n', 'config/new.toml': 'n\n' }) });
		const refused = await unpackZip(instance, 'cfg.zip', 'here', { replace: false }).catch((e) => e);
		expect(refused).toBeInstanceOf(UnpackConflict);
		expect(refused.plan.conflicts).toEqual(['config/a.toml']);
		// Nothing was written when it asked.
		expect(await fs.stat(path.join(instance.path, 'config/new.toml')).catch(() => null)).toBeNull();

		expect((await unpackZip(instance, 'cfg.zip', 'here', { replace: true })).replaced).toBe(1);
		expect(await read(instance.path, 'config/a.toml')).toBe('a = 2\n');
		expect((await listTrash(instance.path)).map((t) => t.path)).toEqual(['config/a.toml']);
	});

	it('counts a file where the zip has a folder as in the way', async () => {
		const instance = await server({ 'x.zip': zipBuffer({ 'config/a.toml/inner.txt': 'i' }) });
		expect((await planUnpack(instance.path, 'x.zip', 'here')).conflicts).toEqual(['config/a.toml']);
	});

	it('refuses a zip whose entries leave the folder, writing nothing', async () => {
		for (const bad of ['../evil.txt', '/etc/evil.txt', 'a/../../evil.txt']) {
			const instance = await server({ 'mods/bad.zip': zipBuffer({ 'ok.txt': 'ok', [bad]: 'x' }) });
			await expect(unpackZip(instance, 'mods/bad.zip', 'here', { replace: true })).rejects.toThrow(/outside the folder/);
			expect(await fs.stat(path.join(instance.path, 'mods/ok.txt')).catch(() => null)).toBeNull();
		}
	});

	it('leaves out Mac clutter, refuses the trash and what is not a zip', async () => {
		const instance = await server({
			'mac.zip': zipBuffer({ '__MACOSX/._a.txt': 'x', 'a.txt': 'a', 'sub/.DS_Store': 'x' }),
			'trash.zip': zipBuffer({ '.mineshell/trash/x': 'x' }),
			'fake.zip': 'not a zip'
		});
		expect((await planUnpack(instance.path, 'mac.zip', 'here')).entries.map((e) => e.out)).toEqual(['a.txt']);
		await expect(planUnpack(instance.path, 'trash.zip', 'here')).rejects.toThrow(/trash/);
		await expect(planUnpack(instance.path, 'fake.zip', 'here')).rejects.toThrow(/not a readable zip/);
	});

	it('refuses a zip holding a file of its own name where it lies', async () => {
		const instance = await server({ 'a.zip': zipBuffer({ 'a.zip': 'inner' }) });
		await expect(planUnpack(instance.path, 'a.zip', 'here')).rejects.toThrow(/own name/);
		expect((await unpackZip(instance, 'a.zip', 'folder', { replace: false })).files).toBe(1);
	});
});
