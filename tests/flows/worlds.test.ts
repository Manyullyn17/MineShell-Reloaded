import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Several worlds per server (worlds.ts, the world tools in world.ts): making
 * a new world, switching between worlds, and what follows the active one
 * (settings, data packs, snapshots, the map).
 */

const { listSnapshots, saveSnapshotPolicy, DEFAULT_POLICY } = await import('#lib/server/snapshots.js');
const { createWorld, deleteWorld, renameWorld, replaceWorld, restoreSnapshot, snapshotNow, switchWorld, worldFromSnapshot, worldFromZip, WorldVersionError } =
	await import('#lib/server/world.js');
const { listWorlds, worldFolderNames, freeWorldFolder, withSizes, readWorldMeta } = await import('#lib/server/worlds.js');
const { readProperties } = await import('#lib/server/properties.js');
const { getMapSettings, keptMapDir, mapDir, saveMapSettings, webRoot } = await import('#lib/server/worldmap.js');
const { diskBreakdown } = await import('#lib/server/diskusage.js');
const { listTrash } = await import('#lib/server/trash.js');
const { listOperations } = await import('#lib/server/operations.js');
const { writeNbt } = await import('#lib/server/nbt.js');
const { packTopLevel } = await import('#lib/server/packchange.js');
const { savedTasks } = await import('#lib/server/chunky.js');
const { createInstance, reload, systemdStopped, tree, waitForTask } = await import('../helpers/instances');
const { restartMineShell, runAndDieAtMove } = await import('../helpers/crash');
const { zipBuffer } = await import('../helpers/fs');
const { TMP_DIR } = await import('#lib/server/config.js');

async function upload(files: Record<string, string | Buffer>): Promise<string> {
	await fs.mkdir(TMP_DIR, { recursive: true });
	const file = path.join(TMP_DIR, `upload-${Math.random().toString(36).slice(2)}.zip`);
	await fs.writeFile(file, zipBuffer(files));
	return file;
}

/** A level.dat saved by Minecraft `version` (Data.Version.Name). */
const levelDat = (version: string) =>
	writeNbt({
		name: '',
		gzipped: true,
		root: {
			type: 'compound',
			value: [
				[
					'Data',
					{
						type: 'compound',
						value: [['Version', { type: 'compound', value: [['Name', { type: 'string', value: version }]] }]]
					}
				]
			]
		}
	});

const FILES = {
	'server.jar': 'fabric',
	'server.properties': 'level-name=world\nlevel-seed=1234\nlevel-type=normal\ndifficulty=hard\n',
	'world/level.dat': levelDat('1.21.1'),
	'world/region/r.0.0.mca': 'chunks',
	'world/datapacks/terralith.zip': 'terralith',
	'world_nether/DIM-1/region/r.0.0.mca': 'nether chunks'
};

const server = (files: Record<string, string | Buffer> = FILES) =>
	createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1', modloaderVersion: '0.16.0', packDatapacks: '["terralith.zip"]' }, files);

const props = async (root: string) => (await readProperties(root)).values;

describe('several worlds per server', () => {
	beforeEach(() => {
		systemdStopped();
		saveSnapshotPolicy(DEFAULT_POLICY);
	});
	afterEach(() => vi.restoreAllMocks());

	it('starts a new world beside the old one, which stays as it was, and switches back with its settings', async () => {
		const instance = await server();
		const before = await tree(instance.path);
		const folder = await createWorld(instance, { name: 'Season 2', seed: '42', copyDatapacks: true, keepMap: true });
		expect(folder).toBe('season-2');

		let values = await props(instance.path);
		expect(values['level-name']).toBe('season-2');
		expect(values['level-seed']).toBe('42');
		// Game settings stay the server's.
		expect(values.difficulty).toBe('hard');
		const files = await tree(instance.path);
		// Nothing of the old world moved; the new one has only the copied data packs until it generates.
		for (const [rel, content] of Object.entries(before)) if (rel !== 'server.properties') expect(files[rel]).toEqual(content);
		expect(files['season-2/datapacks/terralith.zip']).toBe('terralith');
		expect(reload(instance.id).packDatapacks).toBe('["terralith.zip"]');

		const worlds = await listWorlds(instance);
		expect(worlds.map((w) => [w.folder, w.name, w.active, w.generated])).toEqual([
			['season-2', 'Season 2', true, false],
			['world', 'world', false, true]
		]);
		expect(worlds[1].folders).toEqual(['world', 'world_nether']);
		expect(worlds[1].lastRun).toMatchObject({ minecraftVersion: '1.21.1', modloader: 'fabric' });
		expect(worlds[1].version).toBe('1.21.1');
		// Measured as it was left: everything in world/ and world_nether/.
		const bytes = levelDat('1.21.1').length + 'chunks'.length + 'terralith'.length + 'nether chunks'.length;
		expect(worlds[1].sizeBytes).toBe(bytes);
		expect(worlds[0].sizeBytes).toBeNull();

		await switchWorld(reload(instance.id), 'world', { keepMap: true });
		// Active again, so it can change: its old size is dropped.
		expect((await readWorldMeta(instance.path)).worlds.world.sizeBytes).toBeUndefined();
		values = await props(instance.path);
		expect(values['level-name']).toBe('world');
		expect(values['level-seed']).toBe('1234');
		expect(values['level-type']).toBe('normal');
		// And to the new one again: its seed came back with it.
		await switchWorld(reload(instance.id), 'season-2', { keepMap: true });
		expect((await props(instance.path))['level-seed']).toBe('42');
		expect(listOperations()).toEqual([]);
	});

	it('gives a new world no data packs when asked, and remembers per world which came with the pack', async () => {
		const instance = await server();
		await createWorld(instance, { name: 'Plain', seed: '9', copyDatapacks: false, keepMap: true });
		expect(await fs.readdir(instance.path)).not.toContain('plain');
		expect(reload(instance.id).packDatapacks).toBeNull();
		await switchWorld(reload(instance.id), 'world', { keepMap: true });
		expect(reload(instance.id).packDatapacks).toBe('["terralith.zip"]');
		// Left before its first start it has no folder, but it is still there, with its seed.
		expect((await listWorlds(instance)).map((w) => w.folder)).toEqual(['world', 'plain']);
		await switchWorld(reload(instance.id), 'plain', { keepMap: true });
		expect((await props(instance.path))['level-seed']).toBe('9');
	});

	it('takes snapshots of the active world only, and restores one only while its world is active', async () => {
		const instance = await server();
		await waitForTask(await snapshotNow(instance));
		const [ofWorld] = await listSnapshots(instance.path);
		await createWorld(instance, { name: 'Other', seed: null, copyDatapacks: false, keepMap: true });
		await fs.mkdir(path.join(instance.path, 'other'));
		await fs.writeFile(path.join(instance.path, 'other/level.dat'), levelDat('1.21.1'));
		await waitForTask(await snapshotNow(reload(instance.id)));
		const ofOther = (await listSnapshots(instance.path)).find((s) => s.id !== ofWorld.id)!;
		expect(ofOther.world).toBe('other');
		expect(ofOther.worlds).toEqual(['other']);

		await expect(restoreSnapshot(reload(instance.id), ofWorld.id, { snapshot: false })).rejects.toThrow(/Switch to that world/);
		await switchWorld(reload(instance.id), 'world', { keepMap: true });
		await fs.writeFile(path.join(instance.path, 'world/region/r.0.0.mca'), 'played on');
		await waitForTask(await restoreSnapshot(reload(instance.id), ofWorld.id, { snapshot: false }));
		expect((await tree(instance.path))['world/region/r.0.0.mca']).toBe('chunks');
		// The other world was not touched by any of it.
		expect(await fs.readdir(path.join(instance.path, 'other'))).toEqual(['level.dat']);
	});

	it('warns before switching to a world that last ran on a newer Minecraft, and goes ahead when told to', async () => {
		const instance = await server({ ...FILES, 'newer/level.dat': levelDat('1.21.4') });
		await expect(switchWorld(instance, 'newer', { keepMap: true })).rejects.toThrow(WorldVersionError);
		expect((await props(instance.path))['level-name']).toBe('world');
		await switchWorld(instance, 'newer', { keepMap: true, force: true });
		expect((await props(instance.path))['level-name']).toBe('newer');
	});

	it("keeps each world's map for when it is active again, unless told not to", async () => {
		const instance = await server();
		await fs.mkdir(path.join(webRoot(instance.id), 'maps'), { recursive: true });
		await fs.writeFile(path.join(webRoot(instance.id), 'index.html'), 'map of world');
		saveMapSettings(instance.id, { lastRenderAt: 1000, sizeBytes: 12 });

		await createWorld(instance, { name: 'Second', seed: null, copyDatapacks: false, keepMap: true });
		await expect(fs.access(webRoot(instance.id))).rejects.toThrow();
		expect(await fs.readFile(path.join(keptMapDir(instance.id, 'world'), 'web', 'index.html'), 'utf8')).toBe('map of world');
		expect(getMapSettings(instance.id)).toMatchObject({ lastRenderAt: null, sizeBytes: null });
		expect((await listWorlds(instance)).find((w) => w.folder === 'world')).toMatchObject({ mapKept: true, mapBytes: 12 });

		// The second world gets a map of its own, then is left without keeping it.
		await fs.mkdir(webRoot(instance.id), { recursive: true });
		await fs.writeFile(path.join(webRoot(instance.id), 'index.html'), 'map of second');
		await switchWorld(reload(instance.id), 'world', { keepMap: false });
		expect(await fs.readFile(path.join(webRoot(instance.id), 'index.html'), 'utf8')).toBe('map of world');
		expect(getMapSettings(instance.id)).toMatchObject({ lastRenderAt: 1000, sizeBytes: 12 });
		expect(await fs.readdir(mapDir(instance.id))).toEqual(['web']);
	});

	it('puts the previous world back wherever MineShell stopped during a switch', async () => {
		for (const n of [1, 2]) {
			const instance = await server();
			await fs.mkdir(path.join(instance.path, 'other'));
			await fs.writeFile(path.join(instance.path, 'other/level.dat'), levelDat('1.21.1'));
			await fs.mkdir(webRoot(instance.id), { recursive: true });
			await fs.writeFile(path.join(webRoot(instance.id), 'index.html'), 'map of world');
			await fs.mkdir(path.join(keptMapDir(instance.id, 'other'), 'web'), { recursive: true });
			await fs.writeFile(path.join(keptMapDir(instance.id, 'other'), 'web', 'index.html'), 'map of other');

			// The map's moves are the switch's only renames.
			const outcome = await runAndDieAtMove(mapDir(instance.id), n, () => switchWorld(instance, 'other', { keepMap: true }).then(() => ''));
			expect(outcome).toBe('died');
			await restartMineShell();
			expect((await props(instance.path))['level-name']).toBe('world');
			expect(await fs.readFile(path.join(webRoot(instance.id), 'index.html'), 'utf8')).toBe('map of world');
			expect(await fs.readFile(path.join(keptMapDir(instance.id, 'other'), 'web', 'index.html'), 'utf8')).toBe('map of other');
			expect(listOperations()).toEqual([]);
		}
	});

	it("keeps each world's Chunky tasks, which Chunky keys by dimension, not world", async () => {
		const task = 'world=minecraft\\:overworld\ncancelled=false\nshape=square\ncenter-x=0\ncenter-z=0\nradius=500\nchunks=12\ntime=1000\n';
		const instance = await server({ ...FILES, 'config/chunky/config.json': '{"continueOnRestart":true}', 'config/chunky/tasks/minecraft/overworld.properties': task });
		await createWorld(instance, { name: 'Next', seed: null, copyDatapacks: false, keepMap: true });
		// The new world does not get the old one's unfinished task, to show or to continue.
		expect(await savedTasks(instance.path)).toEqual([]);
		await switchWorld(reload(instance.id), 'world', { keepMap: true });
		expect(await savedTasks(instance.path)).toMatchObject([{ world: 'minecraft:overworld', radius: 500, cancelled: false }]);
		await deleteWorld(reload(instance.id), 'next', { snapshots: false });
		expect(Object.keys(await tree(instance.path)).filter((f) => f.includes('chunky-tasks'))).toEqual([]);
	});

	it('keeps Chunky 1.2 tasks per world too, in its one config file', async () => {
		const config = { continueOnRestart: true, language: 'en', tasks: { 'minecraft:overworld': { cancelled: false, radius: 300, centerX: 0, centerZ: 0, shape: 'square', count: 5, time: 1 } } };
		const instance = await server({ ...FILES, 'config/chunky.json': JSON.stringify(config) });
		await createWorld(instance, { name: 'Next', seed: null, copyDatapacks: false, keepMap: true });
		const read = async () => JSON.parse(await fs.readFile(path.join(instance.path, 'config/chunky.json'), 'utf8'));
		expect(await read()).toEqual({ ...config, tasks: {} });
		await switchWorld(reload(instance.id), 'world', { keepMap: true });
		expect(await read()).toEqual(config);
	});

	it("puts Chunky's tasks back wherever MineShell stopped during a switch", async () => {
		const task = 'world=minecraft\\:overworld\ncancelled=false\nradius=500\n';
		const other = 'world=minecraft\\:overworld\ncancelled=false\nradius=64\n';
		for (let n = 1; ; n++) {
			const instance = await server({ ...FILES, 'config/chunky/tasks/minecraft/overworld.properties': task, 'other/level.dat': levelDat('1.21.1') });
			// The other world's tasks, kept from when it was left.
			await fs.mkdir(path.join(instance.path, '.mineshell/chunky-tasks/other/tasks/minecraft'), { recursive: true });
			await fs.writeFile(path.join(instance.path, '.mineshell/chunky-tasks/other/tasks/minecraft/overworld.properties'), other);
			// The tasks are copied (small files): it stops at the n-th copy, until there are none left.
			const realCp = fs.cp.bind(fs);
			let copies = 0;
			const cp = vi.spyOn(fs, 'cp').mockImplementation(async (...args: Parameters<typeof fs.cp>) => {
				if (++copies === n) return new Promise<void>(() => {});
				return realCp(...args);
			});
			const outcome = await Promise.race([
				switchWorld(reload(instance.id), 'other', { keepMap: true }).then(() => 'finished' as const),
				new Promise<'died'>((resolve) => setTimeout(() => resolve('died'), 100))
			]);
			cp.mockRestore();
			if (outcome === 'finished') {
				expect(await savedTasks(instance.path)).toMatchObject([{ radius: 64 }]);
				break;
			}
			await restartMineShell();
			expect(listOperations()).toEqual([]);
			expect((await props(instance.path))['level-name']).toBe('world');
			expect(await savedTasks(instance.path)).toMatchObject([{ radius: 500 }]);
			// And the other world's are still kept for it.
			await switchWorld(reload(instance.id), 'other', { keepMap: true });
			expect(await savedTasks(instance.path)).toMatchObject([{ radius: 64 }]);
			vi.restoreAllMocks();
		}
	});

	it('deletes an inactive world into the trash, with its snapshots when asked, never the active one', async () => {
		const instance = await server();
		await waitForTask(await snapshotNow(instance));
		await createWorld(instance, { name: 'Next', seed: null, copyDatapacks: false, keepMap: true });
		await expect(deleteWorld(reload(instance.id), 'next', { snapshots: false })).rejects.toThrow(/active world/);

		expect(await deleteWorld(reload(instance.id), 'world', { snapshots: true })).toBe(1);
		const files = await tree(instance.path);
		expect(Object.keys(files).filter((f) => f.startsWith('world'))).toEqual([]);
		expect((await listTrash(instance.path)).map((t) => t.path).sort()).toEqual(['world', 'world_nether']);
		expect(await listSnapshots(instance.path)).toEqual([]);
		expect((await listWorlds(instance)).map((w) => w.folder)).toEqual(['next']);
	});

	it('makes a world of its own from a snapshot, siblings renamed with it', async () => {
		const instance = await server();
		await waitForTask(await snapshotNow(instance));
		const [snapshot] = await listSnapshots(instance.path);
		const { taskId, folder } = await worldFromSnapshot(instance, snapshot.id, 'Old times');
		await waitForTask(taskId);
		expect(folder).toBe('old-times');
		const files = await tree(instance.path);
		expect(files['old-times/region/r.0.0.mca']).toBe('chunks');
		expect(files['old-times_nether/DIM-1/region/r.0.0.mca']).toBe('nether chunks');
		const world = (await listWorlds(instance)).find((w) => w.folder === 'old-times')!;
		expect(world).toMatchObject({ name: 'Old times', active: false, folders: ['old-times', 'old-times_nether'] });
		expect((await props(instance.path))['level-name']).toBe('world');
	});

	it('unpacks an uploaded world beside the others, leaving the active one alone', async () => {
		const instance = await server();
		const before = await tree(instance.path);
		const file = await upload({ 'My Save/level.dat': 'save', 'My Save/region/r.0.0.mca': 'save chunks', 'My Save/session.lock': 'x' });
		const { taskId, folder } = await worldFromZip(instance, file, 'Singleplayer');
		await waitForTask(taskId);
		expect(folder).toBe('singleplayer');
		const files = await tree(instance.path);
		expect(files['singleplayer/level.dat']).toBe('save');
		expect(files['singleplayer/region/r.0.0.mca']).toBe('save chunks');
		expect(files['singleplayer/session.lock']).toBeUndefined();
		for (const [rel, content] of Object.entries(before)) expect(files[rel]).toEqual(content);
		expect((await listWorlds(instance)).find((w) => w.folder === 'singleplayer')).toMatchObject({
			name: 'Singleplayer',
			active: false,
			sizeBytes: 'save'.length + 'save chunks'.length
		});
		await expect(fs.access(file)).rejects.toThrow();

		const notAWorld = await upload({ 'readme.txt': 'no' });
		await expect(worldFromZip(instance, notAWorld, 'X')).rejects.toThrow(/no level.dat/);
		await expect(fs.access(notAWorld)).rejects.toThrow();
	});

	// A small zip can unpack to gigabytes, and a full disk fails every server's saves.
	it('refuses an upload that would unpack past the space kept free, before unpacking any of it', async () => {
		const instance = await server();
		const keepFree = DEFAULT_POLICY.minFreeMb * 1024 * 1024;
		const world = { 'Big/level.dat': 'save', 'Big/region/r.0.0.mca': Buffer.alloc(100_000) };
		const freeBytes = (free: number) =>
			vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: free, bsize: 1 } as Awaited<ReturnType<typeof fs.statfs>>);

		freeBytes(keepFree + 50_000);
		const big = await upload(world);
		await expect(worldFromZip(instance, big, 'Big')).rejects.toThrow(/unpacks to 97.\d KB, and only .* is free/);
		await expect(fs.access(big)).rejects.toThrow();
		await expect(replaceWorld(instance, await upload(world), { snapshot: false })).rejects.toThrow(/unpacks to/);
		expect((await listWorlds(instance)).map((w) => w.folder)).toEqual(['world']);

		freeBytes(keepFree + 200_000);
		await waitForTask((await worldFromZip(instance, await upload(world), 'Big')).taskId);
		expect((await listWorlds(instance)).map((w) => w.folder)).toContain('big');
	});

	it('makes an uploaded world the active one when asked, unless it is from a newer Minecraft', async () => {
		const instance = await server();
		const save = await upload({ 'level.dat': levelDat('1.21.1') });
		await waitForTask((await worldFromZip(instance, save, 'Imported', { activate: { keepMap: true } })).taskId);
		expect((await props(instance.path))['level-name']).toBe('imported');
		expect((await listWorlds(instance)).find((w) => w.folder === 'world')).toMatchObject({ active: false });

		const newer = await upload({ 'level.dat': levelDat('1.21.4') });
		const task = await waitForTask((await worldFromZip(reload(instance.id), newer, 'Newer', { activate: { keepMap: true } })).taskId);
		expect((await props(instance.path))['level-name']).toBe('imported');
		expect(task.log.join('\n')).toMatch(/not made the active world.*1\.21\.4/);
		expect((await listWorlds(instance)).find((w) => w.folder === 'newer')).toMatchObject({ active: false });
	});

	it('renames a world without touching its folder', async () => {
		const instance = await server();
		await renameWorld(instance, 'world', 'Main');
		expect((await listWorlds(instance))[0]).toMatchObject({ folder: 'world', name: 'Main' });
		await expect(renameWorld(instance, 'nope', 'X')).rejects.toThrow(/not on this server/);
	});

	it('finds worlds by their level.dat, leaving out siblings and the bisect world, and picks free folders', async () => {
		const instance = await server({
			...FILES,
			'creative/level.dat': 'x',
			'creative_the_end/level.dat': 'x',
			'mineshell-bisect-world/level.dat': 'x',
			'config/level.dat.txt': 'not a world'
		});
		expect(await worldFolderNames(instance.path)).toEqual(['world', 'creative']);
		// Found on disk, never left: measured once and kept.
		expect((await listWorlds(instance)).find((w) => w.folder === 'creative')?.sizeBytes).toBeNull();
		expect((await withSizes(instance, await listWorlds(instance))).find((w) => w.folder === 'creative')?.sizeBytes).toBe(2);
		expect((await readWorldMeta(instance.path)).worlds.creative.sizeBytes).toBe(2);
		expect(await freeWorldFolder(instance.path, 'Creative')).toBe('creative-2');
		expect(await freeWorldFolder(instance.path, 'mods')).toBe('mods-2');
		expect(await freeWorldFolder(instance.path, 'My World_nether')).toBe('my-world');
		expect(await freeWorldFolder(instance.path, '!!!')).toBe('world-2');
	});

	it('counts inactive worlds apart in disk usage, and a pack never takes one for a config folder', async () => {
		const instance = await server({ ...FILES, 'scripts/level.dat': 'a world called scripts' });
		const groups = (await diskBreakdown(instance)).groups;
		expect(groups.find((g) => g.id === 'worlds')?.items.map((i) => i.path)).toEqual(['scripts']);
		expect(groups.find((g) => g.id === 'world')?.items.some((i) => i.path.startsWith('scripts'))).toBe(false);

		const pack = { overrideEntries: ['overrides/scripts/main.zs', 'overrides/config/a.cfg'], downloads: [] } as unknown as Parameters<typeof packTopLevel>[0];
		expect(packTopLevel(pack, new Set(['world', ...(await worldFolderNames(instance.path))]))).toEqual(['config']);
	});
});
