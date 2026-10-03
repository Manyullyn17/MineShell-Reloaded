import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** World snapshots before risky operations (snapshots.ts). */

const { changeLoaderVersion } = await import('$lib/server/instances');
const { LOADERS } = await import('$lib/server/modloaders');
const {
	decideSnapshot,
	listSnapshots,
	saveSnapshotPolicy,
	DEFAULT_POLICY,
	SnapshotChoiceNeeded,
	SNAPSHOTS_DIR
} = await import('$lib/server/snapshots');
const { addJava, clearJava, createInstance, reload, systemdStopped, tree, waitForTask } = await import('../helpers/instances');
const { restartMineShell, runAndDieAtMove } = await import('../helpers/crash');

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
		saveSnapshotPolicy({ keep: 2, askAboveMb: -1 });
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

	describe('whether to ask', () => {
		it('always snapshots below the threshold, whatever the form says', async () => {
			const instance = await instanceWithWorld();
			saveSnapshotPolicy({ keep: 3, askAboveMb: 1 });
			expect(await decideSnapshot(instance.path, 'no')).toBe(true);
		});

		it('needs an answer above it', async () => {
			const instance = await instanceWithWorld();
			saveSnapshotPolicy({ keep: 3, askAboveMb: 0 });
			await expect(decideSnapshot(instance.path, null)).rejects.toBeInstanceOf(SnapshotChoiceNeeded);
			expect(await decideSnapshot(instance.path, 'no')).toBe(false);
			expect(await decideSnapshot(instance.path, 'yes')).toBe(true);
		});

		it('never asks with -1, and still snapshots', async () => {
			const instance = await instanceWithWorld();
			saveSnapshotPolicy({ keep: 3, askAboveMb: -1 });
			expect(await decideSnapshot(instance.path, 'no')).toBe(true);
		});

		it('has nothing to snapshot without a world', async () => {
			const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' }, { 'server.jar': 'x' });
			expect(await decideSnapshot(instance.path, null)).toBe(false);
		});
	});
});
