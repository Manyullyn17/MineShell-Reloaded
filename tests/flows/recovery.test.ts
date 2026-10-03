import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MineShell dying in the middle of an operation and the next start putting
 * the server back (recovery.ts). Pack version changes are covered the same
 * way in pack-change.test.ts.
 */

const { changeLoaderVersion, createFromLoader, migrateToCleanroom, revertToForge, setStatus } = await import(
	'$lib/server/instances'
);
const { LOADERS } = await import('$lib/server/modloaders');
const { listOperations } = await import('$lib/server/operations');
const { recoverInterruptedOperations } = await import('$lib/server/recovery');
const { addJava, clearJava, createInstance, reload, systemdStopped, tree, waitForTask } = await import(
	'../helpers/instances'
);
const { hangForever, restartMineShell, runAndDieAtMove } = await import('../helpers/crash');
const { db } = await import('$lib/server/db');
const { operations } = await import('$lib/server/db/schema');

const FABRIC_FILES = {
	'server.jar': 'fabric launcher 0.15',
	'.fabric/server/cache.bin': 'cache',
	'libraries/net/fabric-loader.jar': 'loader 0.15',
	'world/level.dat': 'my world',
	'config/mod.toml': 'my config',
	'mods/sodium.jar': 'sodium'
};

const FORGE_FILES = {
	'forge-1.12.2-14.23.5.2860.jar': 'forge',
	'minecraft_server.1.12.2.jar': 'vanilla',
	'libraries/net/forge-lib.jar': 'forge lib',
	'world/level.dat': 'my world',
	'mods/jei.jar': 'jei'
};

const fabricInstance = () =>
	createInstance(
		{ modloader: 'fabric', minecraftVersion: '1.21.1', modloaderVersion: '0.15.0', launchArgs: '-jar server.jar nogui' },
		FABRIC_FILES
	);

const forgeInstance = () =>
	createInstance(
		{
			modloader: 'forge',
			minecraftVersion: '1.12.2',
			modloaderVersion: '14.23.5.2860',
			launchArgs: '-jar forge-1.12.2-14.23.5.2860.jar nogui'
		},
		FORGE_FILES
	);

function fakeInstall(loader: 'fabric' | 'cleanroom') {
	return vi.spyOn(LOADERS[loader], 'install').mockImplementation(async (ctx) => {
		await fs.mkdir(path.join(ctx.dir, 'libraries'), { recursive: true });
		await fs.writeFile(path.join(ctx.dir, 'libraries', 'new-lib.jar'), `${loader} ${ctx.loaderVersion}`);
		const jar = loader === 'fabric' ? 'server.jar' : `cleanroom-${ctx.loaderVersion}.jar`;
		await fs.writeFile(path.join(ctx.dir, jar), `${loader} ${ctx.loaderVersion}`);
		return { launchArgs: `-jar ${jar} nogui`, loaderVersion: ctx.loaderVersion ?? 'latest' };
	});
}

/**
 * An install that dies half-way, leaving what real ones leave: the installer
 * (and its log) in .mineshell/, part of libraries/, a partial launch jar.
 */
function installThatDies(loader: 'fabric' | 'cleanroom') {
	let started!: () => void;
	const reached = new Promise<void>((resolve) => (started = resolve));
	vi.spyOn(LOADERS[loader], 'install').mockImplementation(async (ctx) => {
		await fs.writeFile(path.join(ctx.dir, '.mineshell', `${loader}-installer.jar`), 'installer');
		await fs.writeFile(path.join(ctx.dir, '.mineshell', `${loader}-installer.jar.log`), 'log');
		await fs.mkdir(path.join(ctx.dir, 'libraries'), { recursive: true });
		await fs.writeFile(path.join(ctx.dir, 'libraries', 'half.jar'), 'partial');
		await fs.writeFile(path.join(ctx.dir, loader === 'fabric' ? 'server.jar' : 'cleanroom-0.5.17.jar'), 'partial');
		started();
		return hangForever();
	});
	return reached;
}

const ownOperation = (id: string) => listOperations().some((op) => op.instanceId === id);

describe('recovery after MineShell stops mid-operation', () => {
	beforeEach(() => {
		systemdStopped();
		clearJava();
		addJava(8);
		addJava(21);
		addJava(25);
	});
	afterEach(() => vi.restoreAllMocks());

	describe('loader version change', () => {
		it('puts the previous version back wherever it stopped', async () => {
			let stops = 0;
			for (let n = 1; ; n++) {
				const instance = await fabricInstance();
				const before = await tree(instance.path);
				fakeInstall('fabric');
				const outcome = await runAndDieAtMove(instance.path, n, () => changeLoaderVersion(instance, '0.16.5'));
				if (outcome === 'finished') break;
				stops++;

				await restartMineShell();
				expect(await tree(instance.path), `stopped at move ${n}`).toEqual(before);
				expect(reload(instance.id)).toMatchObject({ modloaderVersion: '0.15.0', status: 'ready' });
				expect(reload(instance.id).statusMessage).toMatch(/previous version was put back/);
				expect(ownOperation(instance.id)).toBe(false);
				vi.restoreAllMocks();
			}
			// libraries, .fabric and server.jar each move aside.
			expect(stops).toBe(3);
		});

		it('keeps the moved-aside originals when putting them back fails, and retries next start', async () => {
			const instance = await fabricInstance();
			const before = await tree(instance.path);
			fakeInstall('fabric');
			expect(await runAndDieAtMove(instance.path, 3, () => changeLoaderVersion(instance, '0.16.5'))).toBe('died');

			// The first restart cannot move anything back (an I/O error, say).
			vi.mocked(fs.rename).mockRestore();
			vi.spyOn(fs, 'rename').mockRejectedValue(new Error('EIO'));
			db.update(operations).set({ process: 'previous-process' }).run();
			await recoverInterruptedOperations();
			expect(reload(instance.id).status).toBe('failed');
			// Cleanup used to run anyway and delete the folder holding the originals.
			const aside = (await fs.readdir(path.join(instance.path, '.mineshell'))).filter((n) => n.startsWith('loader-previous-'));
			expect(aside).toHaveLength(1);
			expect(await fs.readdir(path.join(instance.path, '.mineshell', aside[0]))).not.toEqual([]);

			await restartMineShell();
			expect(await tree(instance.path)).toEqual(before);
			expect(reload(instance.id).status).toBe('ready');
		});

		it('drops a half-finished install and puts the previous version back', async () => {
			const instance = await fabricInstance();
			const before = await tree(instance.path);
			const installing = installThatDies('fabric');
			await changeLoaderVersion(instance, '0.16.5');
			await installing;
			await restartMineShell();
			expect(await tree(instance.path)).toEqual(before);
			expect(await fs.readdir(path.join(instance.path, '.mineshell'))).toEqual([]);
		});
	});

	describe('Cleanroom migration', () => {
		it('puts Forge back when it stops during the Cleanroom install', async () => {
			const instance = await forgeInstance();
			const before = await tree(instance.path);
			const installing = installThatDies('cleanroom');
			await migrateToCleanroom(instance, '0.5.17');
			await installing;
			await restartMineShell();
			expect(await tree(instance.path)).toEqual(before);
			expect(reload(instance.id)).toMatchObject({ modloader: 'forge', modloaderVersion: '14.23.5.2860', status: 'ready' });
			expect(reload(instance.id).statusMessage).toMatch(/put back on Forge/);
			// No backup left behind that would block migrating again.
			expect(await fs.readdir(path.join(instance.path, '.mineshell'))).toEqual([]);
		});

		it('puts Forge back wherever it stopped while moving Forge aside', async () => {
			for (let n = 1; n <= 3; n++) {
				const instance = await forgeInstance();
				const before = await tree(instance.path);
				fakeInstall('cleanroom');
				expect(await runAndDieAtMove(instance.path, n, () => migrateToCleanroom(instance, '0.5.17'))).toBe('died');
				await restartMineShell();
				expect(await tree(instance.path), `stopped at move ${n}`).toEqual(before);
				expect(reload(instance.id).modloader).toBe('forge');
				vi.restoreAllMocks();
			}
		});

		it('flags an interrupted revert, which can simply be run again', async () => {
			const instance = await forgeInstance();
			fakeInstall('cleanroom');
			await waitForTask(await migrateToCleanroom(instance, '0.5.17'));
			vi.restoreAllMocks();
			const migrated = reload(instance.id);
			expect(migrated.modloader).toBe('cleanroom');

			expect(await runAndDieAtMove(instance.path, 2, () => revertToForge(migrated))).toBe('died');
			await restartMineShell();
			const flagged = reload(instance.id);
			expect(flagged.status).toBe('failed');
			expect(flagged.statusMessage).toMatch(/Run "Revert to Forge" again/);

			expect((await waitForTask(await revertToForge(flagged))).state).toBe('done');
			expect(reload(instance.id)).toMatchObject({ modloader: 'forge', status: 'ready' });
			expect(await tree(instance.path)).toEqual(FORGE_FILES);
		});
	});

	describe('first install', () => {
		it('marks a server whose setup never finished as failed instead of leaving it busy', async () => {
			// Previously it stayed "being set up" forever: no start, no changes, only delete.
			const installing = installThatDies('fabric');
			const { instance } = await createFromLoader({ name: 'Cut short', minecraftVersion: '1.21.1', modloader: 'fabric' });
			await installing;
			expect(reload(instance.id).status).toBe('provisioning');

			await restartMineShell();
			const row = reload(instance.id);
			expect(row.status).toBe('failed');
			expect(row.statusMessage).toMatch(/Setup was interrupted.*Delete it and add it again/);
			expect(ownOperation(instance.id)).toBe(false);
		});

		it('leaves a finished one alone', async () => {
			fakeInstall('fabric');
			const { instance, taskId } = await createFromLoader({ name: 'Finished', minecraftVersion: '1.21.1', modloader: 'fabric' });
			await waitForTask(taskId);
			expect(ownOperation(instance.id)).toBe(false);
			await restartMineShell();
			expect(reload(instance.id)).toMatchObject({ status: 'ready', statusMessage: null });
		});
	});

	describe('after a change committed', () => {
		it('releases a server whose last steps were cut short and removes leftover folders', async () => {
			const instance = await fabricInstance();
			// The commit went through; MineShell died before the cleanup and the final status.
			setStatus(instance.id, 'provisioning', 'Changing pack to v2');
			await fs.mkdir(path.join(instance.path, '.mineshell', 'pack-change-123', 'mods'), { recursive: true });
			await fs.mkdir(path.join(instance.path, '.mineshell', 'loader-previous-456'), { recursive: true });

			const outcomes = (await recoverInterruptedOperations()).filter((o) => o.instanceId === instance.id);
			expect(outcomes.map((o) => o.kind)).toEqual(['finish', 'cleanup']);
			expect(reload(instance.id).status).toBe('ready');
			expect(reload(instance.id).statusMessage).toMatch(/change itself went through/);
			expect(await fs.readdir(path.join(instance.path, '.mineshell'))).toEqual([]);
		});

		it('keeps a real Forge backup, and drops the empty one a finished revert leaves', async () => {
			const onCleanroom = await createInstance({ modloader: 'cleanroom', minecraftVersion: '1.12.2' }, {
				'.mineshell/forge-backup/manifest.json': '{}',
				'.mineshell/forge-backup/forge-1.12.2.jar': 'forge'
			});
			const reverted = await createInstance({ modloader: 'forge', minecraftVersion: '1.12.2' }, {
				'.mineshell/forge-backup/manifest.json': '{}'
			});
			await recoverInterruptedOperations();
			expect(await fs.readdir(path.join(onCleanroom.path, '.mineshell', 'forge-backup'))).toHaveLength(2);
			expect(await fs.readdir(path.join(reverted.path, '.mineshell'))).toEqual([]);
		});
	});
});
