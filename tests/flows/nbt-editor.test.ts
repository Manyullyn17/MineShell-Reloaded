import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Tag } from '#lib/server/nbt.js';
import type { TreeTag } from '#lib/shared/nbt.js';

const { parseNbt, writeNbt, child } = await import('#lib/server/nbt.js');
const nbtfiles = await import('#lib/server/nbtfiles.js');
const { forgetNbtFiles, nbtSlice, nbtSnbt, partialTree, readNbtFile, restoreNbtVersion, saveNbtEdits, searchNbt, BUDGET, PAGE } = nbtfiles;
const { listVersions } = await import('#lib/server/filehistory.js');
const { listDirectory } = await import('#lib/server/files.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { db } = await import('#lib/server/db/index.js');
const { auditLog } = await import('#lib/server/db/schema.js');
const { createInstance, systemdStopped } = await import('../helpers/instances');
const { fakeProcesses } = await import('../helpers/process');
const { call } = await import('../helpers/routes');
const endpoint = await import('../../src/routes/api/instances/[id]/nbt/+server');

/** The NBT editor in Files (nbtfiles.ts): which files it opens, big files in parts, saving. */

const compound = (entries: [string, Tag][]): Extract<Tag, { type: 'compound' }> => ({ type: 'compound', value: entries });
const str = (value: string): Tag => ({ type: 'string', value });
const int = (value: number): Tag => ({ type: 'int', value });
const file = (root: [string, Tag][], gzipped = true, name = '') => writeNbt({ name, root: compound(root), gzipped });

const LEVEL = file([['Data', compound([['LevelName', str('Home')], ['Time', { type: 'long', value: 1234567890123n }], ['raining', { type: 'byte', value: 0 }]])]]);
/** A mod's file in world/data: plain, a named root, a list longer than a page. */
const MODDATA = file([['data', compound([['entries', { type: 'list', itemType: 'int', value: Array.from({ length: 1200 }, (_, i) => int(i)) }]])]], false, 'root');

const server = (files: Record<string, Buffer>) => createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' }, files);
const read = async (dir: string, rel: string) => parseNbt(await fs.readFile(path.join(dir, rel)));
const saved = (instanceId: string) =>
	db.select().from(auditLog).where(and(eq(auditLog.instanceId, instanceId), eq(auditLog.action, 'file.saved'))).all();

function running() {
	invalidateUnitState();
	fakeProcesses((_cmd, args) => (args.includes('show') ? { stdout: 'ActiveState=active\nSubState=running\n' } : {}));
}

describe('the NBT editor', () => {
	beforeEach(() => {
		systemdStopped();
		forgetNbtFiles();
	});

	it('opens what is NBT as a whole, whatever the name, and refuses what is not', async () => {
		const notNbt = Buffer.from('[1, 2, 3]');
		const trailing = Buffer.concat([file([['a', int(1)]], false), Buffer.from([0, 0, 0])]);
		const zlibbed = zlib.deflateSync(file([['a', int(1)]], false));
		const s = await server({ 'world/level.dat': LEVEL, 'world/data/mod.dat': MODDATA, 'config/favs.dat': notNbt, 'world/x.dat': trailing, 'world/z.dat': zlibbed });

		const level = await readNbtFile(s, 'world/level.dat');
		expect(level).toMatchObject({ gzipped: true, rootName: '', readOnly: null });
		expect(child((await read(s.path, 'world/level.dat')).root, 'Data')).toBeTruthy();
		expect((await readNbtFile(s, 'world/data/mod.dat')).rootName).toBe('root');
		await expect(readNbtFile(s, 'config/favs.dat')).rejects.toThrow(/not an NBT file/);
		await expect(readNbtFile(s, 'world/x.dat')).rejects.toThrow(/3 bytes follow/);
		await expect(readNbtFile(s, 'world/z.dat')).rejects.toThrow(/not an NBT file/);
		await expect(readNbtFile(s, '../outside.dat')).rejects.toThrow();

		// Files offers the editor by name and first bytes; opening it checks the rest.
		const listed = Object.fromEntries((await listDirectory(s.path, 'world')).map((e) => [e.name, e.nbt]));
		expect(listed).toMatchObject({ 'level.dat': true, 'x.dat': true, 'z.dat': false, data: false });
		expect((await listDirectory(s.path, 'config'))[0].nbt).toBe(false);
	});

	it('sends a big file in parts: breadth first within the budget, a page of each list at a time', async () => {
		const wide = compound(Array.from({ length: 30 }, (_, i) => [`c${i}`, compound(Array.from({ length: 100 }, (_, j) => [`v${j}`, int(j)]))]));
		const tree = partialTree(wide) as Extract<TreeTag, { type: 'compound' }>;
		expect(tree.value).toHaveLength(30);
		expect(tree.more).toBe(0);
		const sent = tree.value.reduce((n, [, c]) => n + (c as { value: unknown[] }).value.length, 0);
		expect(sent + 30).toBe(BUDGET);
		// The last ones come empty, saying how many entries they hold.
		expect(tree.value[29][1]).toEqual({ type: 'compound', value: [], more: 100 });

		const s = await server({ 'world/data/mod.dat': MODDATA });
		const view = await readNbtFile(s, 'world/data/mod.dat');
		const entries = ((view.tree as Extract<TreeTag, { type: 'compound' }>).value[0][1] as Extract<TreeTag, { type: 'compound' }>).value[0][1];
		expect(entries).toMatchObject({ type: 'list', more: 1200 - PAGE });
		expect((entries as { value: unknown[] }).value).toHaveLength(PAGE);

		const next = await nbtSlice(s, 'world/data/mod.dat', ['data', 'entries'], PAGE);
		expect(next.tag).toMatchObject({ more: 1200 - 2 * PAGE });
		expect((next.tag as { value: TreeTag[] }).value[0]).toEqual({ type: 'int', value: PAGE });
		// Through a position further on (a search result's), in one piece.
		const far = await nbtSlice(s, 'world/data/mod.dat', ['data', 'entries'], PAGE, 1100);
		expect(far.tag).toMatchObject({ more: 99 });
		await expect(nbtSlice(s, 'world/data/mod.dat', ['data', 'nope'], 0)).rejects.toThrow(/no longer there/);
	});

	it('searches the whole file, with the positions to open the tree that far', async () => {
		const s = await server({ 'world/data/mod.dat': MODDATA, 'world/level.dat': LEVEL });
		const found = await searchNbt(s, 'world/data/mod.dat', '1150');
		expect(found.matches).toEqual([{ path: ['data', 'entries', 1150], positions: [0, 0, 1150], type: 'int', value: '1150' }]);
		const keys = await searchNbt(s, 'world/level.dat', 'levelname');
		expect(keys.matches[0]).toMatchObject({ path: ['Data', 'LevelName'], value: 'Home' });
		const many = await searchNbt(s, 'world/data/mod.dat', '1');
		expect(many.matches).toHaveLength(200);
		expect(many.more).toBe(true);
	});

	it('edits as SNBT the whole of an entry the page holds only in part', async () => {
		const s = await server({ 'world/data/mod.dat': MODDATA });
		const { snbt } = await nbtSnbt(s, 'world/data/mod.dat', ['data', 'entries']);
		expect(snbt.split('\n')).toHaveLength(1202);
		expect(snbt).toContain('1199');
	});

	it('saves each change on its own, writing the file back as it came, and keeps one version per session', async () => {
		const s = await server({ 'world/level.dat': LEVEL, 'world/data/mod.dat': MODDATA });
		const { version } = await readNbtFile(s, 'world/level.dat');
		const t = Date.now();
		const first = await saveNbtEdits(s, 'world/level.dat', version, [{ op: 'set', path: ['Data', 'raining'], value: '1' }], { at: ['Data'], upTo: 0 }, t);
		expect(first.tag).toMatchObject({ type: 'compound', more: 0 });
		const after = await read(s.path, 'world/level.dat');
		expect(after.gzipped).toBe(true);
		expect(child(child(after.root, 'Data'), 'raining')).toEqual({ type: 'byte', value: 1 });
		expect(child(child(after.root, 'Data'), 'Time')).toEqual({ type: 'long', value: 1234567890123n });

		// Within the session: no second version; ten minutes on, the next one.
		const second = await saveNbtEdits(s, 'world/level.dat', first.version, [{ op: 'rename', path: ['Data', 'LevelName'], name: 'Name' }], null, t + 60_000);
		expect(await listVersions(s.path, 'world/level.dat')).toHaveLength(1);
		await saveNbtEdits(s, 'world/level.dat', second.version, [{ op: 'remove', path: ['Data', 'Name'] }], null, t + 11 * 60_000);
		const versions = await listVersions(s.path, 'world/level.dat');
		expect(versions).toHaveLength(2);
		expect(saved(s.id)).toHaveLength(2);
		// The first version kept is the file as it came.
		expect(await fs.readFile(path.join(s.path, '.mineshell/file-history/world/level.dat.versions', versions[1].id))).toEqual(LEVEL);

		// A plain file with a named root stays so.
		const mod = await readNbtFile(s, 'world/data/mod.dat');
		await saveNbtEdits(s, 'world/data/mod.dat', mod.version, [{ op: 'add', path: ['data'], name: 'x', type: 'string', value: 'y' }]);
		const raw = await fs.readFile(path.join(s.path, 'world/data/mod.dat'));
		expect(raw[0]).toBe(0x0a);
		expect(parseNbt(raw).name).toBe('root');
	});

	it('refuses a stale version and a bad change, leaving the file and what is read as they were', async () => {
		const s = await server({ 'world/level.dat': LEVEL });
		const { version } = await readNbtFile(s, 'world/level.dat');
		await expect(saveNbtEdits(s, 'world/level.dat', 'old', [{ op: 'set', path: ['Data', 'raining'], value: '1' }])).rejects.toThrow(/changed since/);
		// The first edit applies in memory, the second fails: nothing of it may stay behind.
		await expect(
			saveNbtEdits(s, 'world/level.dat', version, [
				{ op: 'set', path: ['Data', 'raining'], value: '1' },
				{ op: 'set', path: ['Data', 'raining'], value: '300' }
			])
		).rejects.toThrow(/between -128 and 127/);
		expect(await fs.readFile(path.join(s.path, 'world/level.dat'))).toEqual(LEVEL);
		const data = (await nbtSlice(s, 'world/level.dat', ['Data'], 0)).tag as Extract<TreeTag, { type: 'compound' }>;
		expect(data.value.find(([k]) => k === 'raining')?.[1]).toEqual({ type: 'byte', value: 0 });
		expect(await listVersions(s.path, 'world/level.dat')).toHaveLength(0);
	});

	it('leaves the world a running server is on alone, and nothing else', async () => {
		const s = await server({ 'world/level.dat': LEVEL, 'other/level.dat': LEVEL, 'structures/house.nbt': LEVEL });
		running();
		const view = await readNbtFile(s, 'world/level.dat');
		expect(view.readOnly).toMatch(/running on world/);
		await expect(saveNbtEdits(s, 'world/level.dat', view.version, [{ op: 'set', path: ['Data', 'raining'], value: '1' }])).rejects.toThrow(/Stop the server/);
		expect(await fs.readFile(path.join(s.path, 'world/level.dat'))).toEqual(LEVEL);
		for (const rel of ['other/level.dat', 'structures/house.nbt']) {
			const other = await readNbtFile(s, rel);
			expect(other.readOnly).toBeNull();
			await saveNbtEdits(s, rel, other.version, [{ op: 'set', path: ['Data', 'raining'], value: '1' }]);
		}
	});

	it('puts an earlier version back, keeping the one it replaces', async () => {
		const s = await server({ 'world/level.dat': LEVEL });
		const { version } = await readNbtFile(s, 'world/level.dat');
		const changed = await saveNbtEdits(s, 'world/level.dat', version, [{ op: 'remove', path: ['Data', 'LevelName'] }]);
		const [kept] = await listVersions(s.path, 'world/level.dat');
		await restoreNbtVersion(s, 'world/level.dat', changed.version, kept.id);
		expect(await fs.readFile(path.join(s.path, 'world/level.dat'))).toEqual(LEVEL);
		expect(await listVersions(s.path, 'world/level.dat')).toHaveLength(2);
	});

	it('answers over its endpoint, refusals with their reason', async () => {
		const s = await server({ 'world/level.dat': LEVEL });
		const params = { id: s.id };
		const at = encodeURIComponent(JSON.stringify(['Data']));
		const slice = await call(endpoint.GET, { params, url: `http://localhost/?path=world/level.dat&at=${at}` });
		expect((await slice.json()).tag.value).toHaveLength(3);
		const search = await call(endpoint.GET, { params, url: 'http://localhost/?path=world/level.dat&q=home' });
		expect((await search.json()).matches).toHaveLength(1);

		const { version } = await readNbtFile(s, 'world/level.dat');
		const bad = await call(endpoint.POST, { params, method: 'POST', json: { path: 'world/level.dat', version, edits: [{ op: 'set', path: ['Data', 'Time'], value: 'soon' }] } });
		expect(bad.status).toBe(400);
		expect((await bad.json()).message).toMatch(/not a whole number/);
		const odd = await call(endpoint.POST, { params, method: 'POST', json: { path: 'world/level.dat', version, edits: [{ op: 'item' }] } });
		expect(odd.status).toBe(400);
		const ok = await call(endpoint.POST, {
			params,
			method: 'POST',
			json: { path: 'world/level.dat', version, edits: [{ op: 'set', path: ['Data', 'Time'], value: '5' }], refresh: { at: ['Data'], upTo: 0 } }
		});
		expect(ok.status).toBe(200);
		expect((await ok.json()).tag.value[1]).toEqual(['Time', { type: 'long', value: '5' }]);
	});
});
