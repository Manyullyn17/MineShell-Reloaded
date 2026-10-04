import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeLoaderVersion } from '#lib/server/instances.js';
import { LOADERS } from '#lib/server/modloaders.js';
import { UNITS_DIR } from '#lib/server/config.js';
import { invalidateUnitState } from '#lib/server/systemd.js';
import { addJava, clearJava, createInstance, reload, systemdStopped, tree, waitForTask } from '../helpers/instances';
import { fakeProcesses } from '../helpers/process';

const FORGE_FILES = {
	'forge-1.12.2-14.23.5.2859.jar': 'old forge',
	'minecraft_server.1.12.2.jar': 'vanilla',
	'libraries/net/old.jar': 'old lib',
	'world/level.dat': 'my world',
	'config/mod.cfg': 'my config',
	'mods/mod.jar': 'a mod',
	'server.properties': 'server-port=25565\n'
};

async function forgeInstance() {
	return createInstance(
		{ modloader: 'forge', minecraftVersion: '1.12.2', modloaderVersion: '14.23.5.2859', launchArgs: '-jar forge-1.12.2-14.23.5.2859.jar nogui' },
		FORGE_FILES
	);
}

describe('changing the loader version', () => {
	beforeEach(() => {
		systemdStopped();
		clearJava();
		addJava(8);
	});
	afterEach(() => vi.restoreAllMocks());

	it('replaces the loader files and leaves everything else alone', async () => {
		const install = vi.spyOn(LOADERS.forge, 'install').mockImplementation(async (ctx) => {
			// The old install has been moved aside by now.
			expect(await fs.readdir(ctx.dir)).not.toContain('libraries');
			await fs.mkdir(path.join(ctx.dir, 'libraries/net'), { recursive: true });
			await fs.writeFile(path.join(ctx.dir, 'libraries/net/new.jar'), 'new lib');
			await fs.writeFile(path.join(ctx.dir, 'forge-1.12.2-14.23.5.2860.jar'), 'new forge');
			await fs.writeFile(path.join(ctx.dir, 'minecraft_server.1.12.2.jar'), 'vanilla');
			return { launchArgs: '-jar forge-1.12.2-14.23.5.2860.jar nogui', loaderVersion: ctx.loaderVersion! };
		});
		const instance = await forgeInstance();

		const task = await waitForTask(await changeLoaderVersion(instance, '14.23.5.2860'));
		expect(task.state).toBe('done');
		expect(install.mock.calls[0][0]).toMatchObject({ loaderVersion: '14.23.5.2860', minecraftVersion: '1.12.2', javaPath: '/fake/jvm/java-8/bin/java' });

		expect(await tree(instance.path)).toEqual({
			'forge-1.12.2-14.23.5.2860.jar': 'new forge',
			'minecraft_server.1.12.2.jar': 'vanilla',
			'libraries/net/new.jar': 'new lib',
			'world/level.dat': 'my world',
			'config/mod.cfg': 'my config',
			'mods/mod.jar': 'a mod',
			'server.properties': 'server-port=25565\n'
		});
		// The aside copy is gone once the new install is in.
		expect(await fs.readdir(path.join(instance.path, '.mineshell')).catch(() => [])).toEqual([]);

		const after = reload(instance.id);
		expect(after).toMatchObject({ modloaderVersion: '14.23.5.2860', launchArgs: '-jar forge-1.12.2-14.23.5.2860.jar nogui', status: 'ready', statusMessage: null });
		expect(await fs.readFile(path.join(UNITS_DIR, `${instance.id}.env`), 'utf8')).toContain('MS_LAUNCH_ARGS=-jar forge-1.12.2-14.23.5.2860.jar nogui');
	});

	it('puts the old install back exactly when the new one fails', async () => {
		vi.spyOn(LOADERS.forge, 'install').mockImplementation(async (ctx) => {
			// A half-finished install: some new files, then failure.
			await fs.mkdir(path.join(ctx.dir, 'libraries/net'), { recursive: true });
			await fs.writeFile(path.join(ctx.dir, 'libraries/net/partial.jar'), 'partial');
			throw new Error('Download failed (404)');
		});
		const instance = await forgeInstance();
		const before = await tree(instance.path);

		const task = await waitForTask(await changeLoaderVersion(instance, '99.99.99'));
		expect(task.state).toBe('failed');
		expect(await tree(instance.path)).toEqual(before);
		const after = reload(instance.id);
		expect(after).toMatchObject({ modloaderVersion: '14.23.5.2859', launchArgs: '-jar forge-1.12.2-14.23.5.2859.jar nogui', status: 'ready' });
		expect(after.statusMessage).toMatch(/restored/);
	});

	it('loses nothing when moving the old install aside fails part-way', async () => {
		// The original rollback bug: originals not yet moved were deleted.
		const install = vi.spyOn(LOADERS.forge, 'install');
		const instance = await forgeInstance();
		const before = await tree(instance.path);
		const realRename = fs.rename.bind(fs);
		let moves = 0;
		vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
			if (String(to).includes('loader-previous') && ++moves === 2) throw new Error('EIO: disk hiccup');
			return realRename(from, to);
		});

		const task = await waitForTask(await changeLoaderVersion(instance, '14.23.5.2860'));
		expect(task.state).toBe('failed');
		expect(install).not.toHaveBeenCalled();
		expect(await tree(instance.path)).toEqual(before);
	});

	it('refuses while the server is running', async () => {
		invalidateUnitState();
		fakeProcesses((cmd, args) => (args.includes('show') ? { stdout: 'ActiveState=active\nSubState=running\n' } : {}));
		const instance = await forgeInstance();
		await expect(changeLoaderVersion(instance, '14.23.5.2860')).rejects.toThrow(/Stop the server first/);
		expect(await tree(instance.path)).toEqual(FORGE_FILES);
	});

	it('refuses when the Java the new version needs is missing', async () => {
		// Cleanroom 0.4.x runs on Java 21, 0.5+ needs Java 25.
		addJava(21);
		const install = vi.spyOn(LOADERS.cleanroom, 'install');
		const instance = await createInstance({ modloader: 'cleanroom', minecraftVersion: '1.12.2', modloaderVersion: '0.4.4-alpha' });
		await expect(changeLoaderVersion(instance, '0.5.17-alpha')).rejects.toThrow(/Java 25/);
		expect(install).not.toHaveBeenCalled();
	});

	it('installs with the Java the new version needs', async () => {
		addJava(21);
		addJava(25);
		const install = vi.spyOn(LOADERS.cleanroom, 'install').mockResolvedValue({ launchArgs: '-jar cleanroom-0.5.17-alpha.jar nogui', loaderVersion: '0.5.17-alpha' });
		const instance = await createInstance({ modloader: 'cleanroom', minecraftVersion: '1.12.2', modloaderVersion: '0.4.4-alpha' });
		expect((await waitForTask(await changeLoaderVersion(instance, '0.5.17-alpha'))).state).toBe('done');
		expect(install.mock.calls[0][0].javaPath).toBe('/fake/jvm/java-25/bin/java');
	});

	it('has nothing to change on vanilla', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		await expect(changeLoaderVersion(instance, '1')).rejects.toThrow(/Vanilla/);
	});
});
