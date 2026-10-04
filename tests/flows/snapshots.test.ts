import fs from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * World snapshots before risky operations (snapshots.ts) and the world tools
 * built on the same moves (world.ts): reset, replace, restore.
 */

const { changeLoaderVersion } = await import('$lib/server/instances');
const { LOADERS } = await import('$lib/server/modloaders');
const { listOperations } = await import('$lib/server/operations');
const {
	decideSnapshot,
	listSnapshots,
	pruneSnapshots,
	saveSnapshotPolicy,
	setSnapshotPinned,
	DEFAULT_POLICY,
	SnapshotChoiceNeeded,
	SNAPSHOTS_DIR
} = await import('$lib/server/snapshots');
const { replaceWorld, resetWorld, restoreSnapshot, snapshotNow, zipWorlds, worldRootIn, entryTarget } = await import(
	'$lib/server/world'
);
const { readProperties } = await import('$lib/server/properties');
const { TMP_DIR } = await import('$lib/server/config');
const { addJava, clearJava, createInstance, reload, systemdStopped, tree, waitForTask } = await import('../helpers/instances');
const { restartMineShell, runAndDieAtMove } = await import('../helpers/crash');
const { zipBuffer } = await import('../helpers/fs');

const FILES = {
	'server.jar': 'fabric launcher 0.15',
	'libraries/net/fabric-loader.jar': 'loader 0.15',
	'server.properties': 'level-name=world\nlevel-seed=1234\n',
	'world/level.dat': 'my world',
	'world/region/r.0.0.mca': 'chunks',
	'world_nether/DIM-1/region/r.0.0.mca': 'nether chunks',
	'mods/sodium.jar': 'sodium'
};

const instanceWithWorld = () =>
	createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1', modloaderVersion: '0.15.0' }, FILES);

function fakeInstall() {
	return vi.spyOn(LOADERS.fabric, 'install').mockImplementation(async (ctx) => {
		await fs.writeFile(path.join(ctx.dir, 'server.jar'), `fabric ${ctx.loaderVersion}`);
		return { launchArgs: '-jar server.jar nogui', loaderVersion: ctx.loaderVersion ?? 'latest' };
	});
}

/** Everything in one snapshot folder, minus its manifest. */
async function snapshotTree(root: string, id: string) {
	const all = await tree(path.join(root, SNAPSHOTS_DIR, id), /^$/);
	delete all['manifest.json'];
	return all;
}

async function zipNames(buffer: Buffer): Promise<string[]> {
	return new Promise((resolve, reject) =>
		yauzl.fromBuffer(buffer, (err, zip) => {
			if (err) return reject(err);
			const names: string[] = [];
			zip.on('entry', (e: yauzl.Entry) => names.push(e.fileName));
			zip.on('end', () => resolve(names.sort()));
		})
	);
}

async function upload(files: Record<string, string>): Promise<string> {
	await fs.mkdir(TMP_DIR, { recursive: true });
	const file = path.join(TMP_DIR, `upload-${Math.random().toString(36).slice(2)}.zip`);
	await fs.writeFile(file, zipBuffer(files));
	return file;
}

describe('world snapshots', () => {
	beforeEach(() => {
		systemdStopped();
		clearJava();
		addJava(21);
		saveSnapshotPolicy(DEFAULT_POLICY);
	});
	afterEach(() => vi.restoreAllMocks());

	it('copies every world folder before a loader change, and keeps the newest ones only', async () => {
		const instance = await instanceWithWorld();
		fakeInstall();
		saveSnapshotPolicy({ keepMin: 2, keepMax: 2, askAboveMb: -1 });
		for (const version of ['0.16.0', '0.16.5', '0.17.0']) {
			expect((await waitForTask(await changeLoaderVersion(reload(instance.id), version, { snapshot: true }))).state).toBe('done');
		}
		const snapshots = await listSnapshots(instance.path);
		expect(snapshots).toHaveLength(2);
		expect(snapshots[0]).toMatchObject({
			reason: 'loader-change',
			worlds: ['world', 'world_nether'],
			modloaderVersion: '0.16.5',
			label: 'Before changing Fabric 0.16.5 to 0.17.0'
		});
		expect(await snapshotTree(instance.path, snapshots[0].id)).toEqual({
			'world/level.dat': 'my world',
			'world/region/r.0.0.mca': 'chunks',
			'world_nether/DIM-1/region/r.0.0.mca': 'nether chunks'
		});
		// The world itself is untouched.
		expect((await tree(instance.path))['world/level.dat']).toBe('my world');
	});

	it('keeps pinned snapshots, without them counting towards the limit', async () => {
		const instance = await instanceWithWorld();
		saveSnapshotPolicy({ keepMin: 10, askAboveMb: -1 });
		for (let i = 0; i < 4; i++) await waitForTask(await snapshotNow(reload(instance.id)));
		const [newest, , , oldest] = await listSnapshots(instance.path);
		await setSnapshotPinned(instance.path, oldest.id, true);
		await pruneSnapshots(instance.path, { ...DEFAULT_POLICY, keepMin: 2, keepMax: 2 });
		const left = await listSnapshots(instance.path);
		// The two newest unpinned ones, plus the pinned oldest.
		expect(left.map((s) => s.id)).toEqual([newest.id, left[1].id, oldest.id]);
		expect(left.find((s) => s.id === oldest.id)?.pinned).toBe(true);

		await setSnapshotPinned(instance.path, oldest.id, false);
		await pruneSnapshots(instance.path, { ...DEFAULT_POLICY, keepMin: 2, keepMax: 2 });
		expect((await listSnapshots(instance.path)).map((s) => s.id)).not.toContain(oldest.id);
	});

	it('takes none unless asked', async () => {
		const instance = await instanceWithWorld();
		fakeInstall();
		await waitForTask(await changeLoaderVersion(instance, '0.16.5'));
		expect(await listSnapshots(instance.path)).toEqual([]);
	});

	it('fails the operation before anything moves when the snapshot cannot be taken', async () => {
		const instance = await instanceWithWorld();
		const before = await tree(instance.path);
		const install = fakeInstall();
		vi.spyOn(fs, 'cp').mockRejectedValue(new Error('ENOSPC: no space left on device'));
		const task = await waitForTask(await changeLoaderVersion(instance, '0.16.5', { snapshot: true }));
		expect(task.state).toBe('failed');
		expect(install).not.toHaveBeenCalled();
		expect(await tree(instance.path)).toEqual(before);
		expect(reload(instance.id).statusMessage).toMatch(/no space left/);
		expect(await fs.readdir(path.join(instance.path, SNAPSHOTS_DIR))).toEqual([]);
	});

	it('drops a snapshot cut short by MineShell stopping, and the operation with it', async () => {
		const instance = await instanceWithWorld();
		const before = await tree(instance.path);
		fakeInstall();
		// Move 1 is the finished copy becoming a snapshot.
		expect(await runAndDieAtMove(instance.path, 1, () => changeLoaderVersion(instance, '0.16.5', { snapshot: true }))).toBe('died');
		await restartMineShell();
		expect(await tree(instance.path)).toEqual(before);
		expect(await fs.readdir(path.join(instance.path, SNAPSHOTS_DIR))).toEqual([]);
		expect(reload(instance.id)).toMatchObject({ status: 'ready', modloaderVersion: '0.15.0' });
	});

	it('is taken by hand too', async () => {
		const instance = await instanceWithWorld();
		expect((await waitForTask(await snapshotNow(instance))).state).toBe('done');
		const [snapshot] = await listSnapshots(instance.path);
		expect(snapshot).toMatchObject({ reason: 'manual', worlds: ['world', 'world_nether'] });
		expect(reload(instance.id)).toMatchObject({ status: 'ready', statusMessage: null });
		expect(listOperations().some((op) => op.instanceId === instance.id)).toBe(false);
	});

	describe('whether to ask', () => {
		it('always snapshots below the threshold, whatever the form says', async () => {
			const instance = await instanceWithWorld();
			saveSnapshotPolicy({ askAboveMb: 1 });
			expect(await decideSnapshot(instance, 'no')).toBe(true);
		});

		it('needs an answer above it', async () => {
			const instance = await instanceWithWorld();
			saveSnapshotPolicy({ askAboveMb: 0 });
			await expect(decideSnapshot(instance, null)).rejects.toBeInstanceOf(SnapshotChoiceNeeded);
			expect(await decideSnapshot(instance, 'no')).toBe(false);
			expect(await decideSnapshot(instance, 'yes')).toBe(true);
		});

		it('never asks with -1, and still snapshots', async () => {
			const instance = await instanceWithWorld();
			saveSnapshotPolicy({ askAboveMb: -1 });
			expect(await decideSnapshot(instance, 'no')).toBe(true);
		});

		it('has nothing to snapshot without a world', async () => {
			const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' }, { 'server.jar': 'x' });
			expect(await decideSnapshot(instance, null)).toBe(false);
		});
	});
});

describe('world tools', () => {
	beforeEach(() => {
		systemdStopped();
		saveSnapshotPolicy(DEFAULT_POLICY);
	});
	afterEach(() => vi.restoreAllMocks());

	it('resets the world into a snapshot, with a new seed', async () => {
		const instance = await instanceWithWorld();
		await waitForTask(await resetWorld(instance, { snapshot: true, seed: { mode: 'set', seed: '42' } }));
		const files = await tree(instance.path);
		expect(Object.keys(files).filter((f) => f.startsWith('world'))).toEqual([]);
		expect((await readProperties(instance.path)).values['level-seed']).toBe('42');
		const [snapshot] = await listSnapshots(instance.path);
		expect(snapshot.reason).toBe('world-reset');
		expect(await snapshotTree(instance.path, snapshot.id)).toMatchObject({ 'world/level.dat': 'my world' });
	});

	it('deletes the old world when no snapshot is wanted', async () => {
		const instance = await instanceWithWorld();
		await waitForTask(await resetWorld(instance, { snapshot: false, seed: { mode: 'keep' } }));
		expect(await listSnapshots(instance.path)).toEqual([]);
		expect(await fs.readdir(path.join(instance.path, '.mineshell'))).toEqual([]);
		expect((await readProperties(instance.path)).values['level-seed']).toBe('1234');
	});

	it('restores a snapshot, keeping the world it replaces', async () => {
		const instance = await instanceWithWorld();
		await waitForTask(await snapshotNow(instance));
		const [first] = await listSnapshots(instance.path);
		await fs.writeFile(path.join(instance.path, 'world/level.dat'), 'played on');
		await fs.rm(path.join(instance.path, 'world_nether'), { recursive: true });

		await waitForTask(await restoreSnapshot(reload(instance.id), first.id, { snapshot: true }));
		const files = await tree(instance.path);
		expect(files['world/level.dat']).toBe('my world');
		expect(files['world_nether/DIM-1/region/r.0.0.mca']).toBe('nether chunks');
		const snapshots = await listSnapshots(instance.path);
		expect(snapshots.map((s) => s.reason)).toEqual(['world-restore', 'manual']);
		expect(await snapshotTree(instance.path, snapshots[0].id)).toEqual({
			'world/level.dat': 'played on',
			'world/region/r.0.0.mca': 'chunks'
		});
		// The restored snapshot is still whole.
		expect(await snapshotTree(instance.path, first.id)).toMatchObject({ 'world/level.dat': 'my world' });
	});

	it('replaces the world with one zipped inside a folder', async () => {
		const instance = await instanceWithWorld();
		const file = await upload({
			'My World/level.dat': 'uploaded',
			'My World/region/r.1.1.mca': 'uploaded chunks',
			'My World/session.lock': 'lock',
			'My World/../../escape.txt': 'nope'
		});
		await waitForTask(await replaceWorld(instance, file, { snapshot: false }));
		const files = await tree(instance.path);
		expect(files['world/level.dat']).toBe('uploaded');
		expect(files['world/region/r.1.1.mca']).toBe('uploaded chunks');
		expect(files['world/session.lock']).toBeUndefined();
		expect(Object.keys(files).some((f) => f.includes('escape'))).toBe(false);
		// The old nether went with the old world, and the upload is cleaned up.
		expect(files['world_nether/DIM-1/region/r.0.0.mca']).toBeUndefined();
		await expect(fs.access(file)).rejects.toThrow();
	});

	it('refuses a zip without a world before touching anything', async () => {
		const instance = await instanceWithWorld();
		const before = await tree(instance.path);
		const file = await upload({ 'readme.txt': 'not a world' });
		await expect(replaceWorld(instance, file, { snapshot: true })).rejects.toThrow(/no level.dat/);
		expect(await tree(instance.path)).toEqual(before);
		expect(reload(instance.id).status).toBe('ready');
	});

	it('puts the world back wherever MineShell stopped during a change', async () => {
		let stops = 0;
		for (let n = 1; ; n++) {
			const instance = await instanceWithWorld();
			const before = await tree(instance.path);
			const file = await upload({ 'level.dat': 'uploaded', 'region/r.0.0.mca': 'new' });
			const outcome = await runAndDieAtMove(instance.path, n, () => replaceWorld(instance, file, { snapshot: true }));
			if (outcome === 'finished') break;
			stops++;
			const [outcomeOf] = (await restartMineShell()).filter((o) => o.instanceId === instance.id);
			expect(await tree(instance.path), `stopped at move ${n}`).toEqual(before);
			expect(outcomeOf.message).toMatch(/previous world was put back/);
			expect(await listSnapshots(instance.path)).toEqual([]);
			expect(await fs.readdir(path.join(instance.path, '.mineshell'))).toEqual(
				(await fs.readdir(path.join(instance.path, '.mineshell'))).filter((n) => n === 'snapshots')
			);
			vi.restoreAllMocks();
			systemdStopped();
		}
		// Two folders aside, one into place, the snapshot finishing.
		expect(stops).toBe(4);
	});

	it('zips worlds with their folder names, without the session lock', async () => {
		const instance = await instanceWithWorld();
		await fs.writeFile(path.join(instance.path, 'world/session.lock'), 'lock');
		const stream = await zipWorlds(instance.path, ['world', 'world_nether']);
		const chunks: Buffer[] = [];
		for await (const chunk of stream) chunks.push(chunk as Buffer);
		expect(await zipNames(Buffer.concat(chunks))).toEqual([
			'world/level.dat',
			'world/region/r.0.0.mca',
			'world_nether/DIM-1/region/r.0.0.mca'
		]);
	});

	it('finds the world inside an upload', () => {
		expect(worldRootIn(['level.dat', 'region/r.0.0.mca'])).toBe('');
		expect(worldRootIn(['saves/A/level.dat', 'saves/A/DIM1/level.dat', 'B/level.dat'])).toBe('B/');
		expect(worldRootIn(['readme.txt'])).toBeNull();
		expect(entryTarget('B/region/x.mca', 'B/')).toBe('region/x.mca');
		expect(entryTarget('B/../x', 'B/')).toBeNull();
		expect(entryTarget('C/level.dat', 'B/')).toBeNull();
	});
});
