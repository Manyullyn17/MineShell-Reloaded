import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerInstance } from '$lib/server/db/schema';

// Cleanroom's own mod fixes (Fugue/Scalar downloads, mod disabling) are unit
// tested in cleanroom.test.ts; here a stand-in disables one mod and adds one,
// which is exactly what a revert has to undo.
vi.mock('$lib/server/cleanroom', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/cleanroom')>();
	return {
		...actual,
		applyCleanroomModFixes: async (instance: ServerInstance) => {
			const mods = path.join(instance.path, 'mods');
			await fs.rename(path.join(mods, 'normalasm.jar'), path.join(mods, 'normalasm.jar.disabled'));
			await fs.writeFile(path.join(mods, '+Fugue-0.23.3.jar'), 'fugue');
			return { disabled: ['normalasm.jar'], added: ['+Fugue-0.23.3.jar'], failures: [], advise: [] };
		}
	};
});

const { migrateToCleanroom, readForgeBackup, revertToForge } = await import('$lib/server/instances');
const { LOADERS } = await import('$lib/server/modloaders');
const { addJava, clearJava, createInstance, reload, systemdStopped, tree, waitForTask } = await import('../helpers/instances');

const FORGE_FILES = {
	'forge-1.12.2-14.23.5.2860.jar': 'forge',
	'minecraft_server.1.12.2.jar': 'vanilla',
	'libraries/net/forge-lib.jar': 'forge lib',
	'world/level.dat': 'my world',
	'config/mod.cfg': 'my config',
	'mods/normalasm.jar': 'normalasm',
	'mods/jei.jar': 'jei',
	'server.properties': 'server-port=25565\n'
};

async function forgeInstance() {
	return createInstance(
		{
			modloader: 'forge',
			minecraftVersion: '1.12.2',
			modloaderVersion: '14.23.5.2860',
			launchArgs: '-jar forge-1.12.2-14.23.5.2860.jar nogui',
			jvmArgs: '-Xms1024M -Xmx4096M -XX:+UseConcMarkSweepGC -XX:+UseG1GC',
			javaPath: addJava(8)
		},
		FORGE_FILES
	);
}

function fakeCleanroomInstall() {
	return vi.spyOn(LOADERS.cleanroom, 'install').mockImplementation(async (ctx) => {
		await fs.mkdir(path.join(ctx.dir, 'libraries/com'), { recursive: true });
		await fs.writeFile(path.join(ctx.dir, 'libraries/com/cleanroom-lib.jar'), 'cleanroom lib');
		await fs.writeFile(path.join(ctx.dir, `cleanroom-${ctx.loaderVersion}.jar`), 'cleanroom');
		await fs.writeFile(path.join(ctx.dir, 'minecraft_server.1.12.2.jar'), 'vanilla');
		return { launchArgs: `-jar cleanroom-${ctx.loaderVersion}.jar nogui`, loaderVersion: ctx.loaderVersion! };
	});
}

describe('Cleanroom migration', () => {
	beforeEach(() => {
		systemdStopped();
		clearJava();
		addJava(25);
	});
	afterEach(() => vi.restoreAllMocks());

	it('moves Forge into a backup and installs Cleanroom', async () => {
		const install = fakeCleanroomInstall();
		const instance = await forgeInstance();

		expect((await waitForTask(await migrateToCleanroom(instance, '0.5.17-alpha'))).state).toBe('done');
		expect(install.mock.calls[0][0].javaPath).toBe('/fake/jvm/java-25/bin/java');

		expect(await tree(instance.path)).toEqual({
			'cleanroom-0.5.17-alpha.jar': 'cleanroom',
			'minecraft_server.1.12.2.jar': 'vanilla',
			'libraries/com/cleanroom-lib.jar': 'cleanroom lib',
			'world/level.dat': 'my world',
			'config/mod.cfg': 'my config',
			'mods/normalasm.jar.disabled': 'normalasm',
			'mods/jei.jar': 'jei',
			'mods/+Fugue-0.23.3.jar': 'fugue',
			'server.properties': 'server-port=25565\n'
		});
		expect(await tree(path.join(instance.path, '.mineshell/forge-backup'), /^manifest\.json$/)).toEqual({
			'forge-1.12.2-14.23.5.2860.jar': 'forge',
			'minecraft_server.1.12.2.jar': 'vanilla',
			'libraries/net/forge-lib.jar': 'forge lib'
		});
		expect(await readForgeBackup(reload(instance.id))).toMatchObject({
			modloaderVersion: '14.23.5.2860',
			javaPath: '/fake/jvm/java-8/bin/java',
			disabledMods: ['normalasm.jar'],
			addedMods: ['+Fugue-0.23.3.jar']
		});
		expect(reload(instance.id)).toMatchObject({
			modloader: 'cleanroom',
			modloaderVersion: '0.5.17-alpha',
			launchArgs: '-jar cleanroom-0.5.17-alpha.jar nogui',
			// Java 8-only flags would stop Java 25 from starting.
			jvmArgs: '-Xms1024M -Xmx4096M -XX:+UseG1GC',
			// A Java 8 pin cannot run Cleanroom; auto-matching takes over.
			javaPath: null,
			status: 'ready'
		});
	});

	it('reverts to exactly the Forge install it replaced', async () => {
		fakeCleanroomInstall();
		const instance = await forgeInstance();
		const before = { files: await tree(instance.path), row: reload(instance.id) };
		await waitForTask(await migrateToCleanroom(instance, '0.5.17-alpha'));

		expect((await waitForTask(await revertToForge(reload(instance.id)))).state).toBe('done');
		expect(await tree(instance.path)).toEqual(before.files);
		expect(await readForgeBackup(reload(instance.id))).toBeNull();
		const after = reload(instance.id);
		for (const key of ['modloader', 'modloaderVersion', 'launchArgs', 'jvmArgs', 'javaPath'] as const) {
			expect(after[key]).toBe(before.row[key]);
		}
	});

	it('rolls everything back when the Cleanroom install fails', async () => {
		vi.spyOn(LOADERS.cleanroom, 'install').mockImplementation(async (ctx) => {
			await fs.mkdir(path.join(ctx.dir, 'libraries'), { recursive: true });
			await fs.writeFile(path.join(ctx.dir, 'libraries/half.jar'), 'half');
			throw new Error('installer exited with 1');
		});
		const instance = await forgeInstance();
		const before = { files: await tree(instance.path), row: reload(instance.id) };

		expect((await waitForTask(await migrateToCleanroom(instance, '0.5.17-alpha'))).state).toBe('failed');
		expect(await tree(instance.path)).toEqual(before.files);
		expect(await readForgeBackup(reload(instance.id))).toBeNull();
		const after = reload(instance.id);
		expect(after).toMatchObject({ modloader: 'forge', jvmArgs: before.row.jvmArgs, javaPath: before.row.javaPath, status: 'ready' });
		expect(after.statusMessage).toMatch(/rolled back/);
	});

	it('refuses when the Java Cleanroom needs is missing, before touching anything', async () => {
		clearJava();
		addJava(21);
		const install = vi.spyOn(LOADERS.cleanroom, 'install');
		const instance = await forgeInstance();
		// No version given means the latest, which needs Java 25.
		await expect(migrateToCleanroom(instance, null)).rejects.toThrow(/Java 25/);
		expect(install).not.toHaveBeenCalled();
		expect(await tree(instance.path)).toEqual(FORGE_FILES);
	});

	it('refuses what it cannot migrate', async () => {
		const neo = await createInstance({ modloader: 'neoforge', minecraftVersion: '1.21.1' });
		await expect(migrateToCleanroom(neo, null)).rejects.toThrow(/Forge 1\.12\.2/);

		const withBackup = await forgeInstance();
		await fs.mkdir(path.join(withBackup.path, '.mineshell/forge-backup'), { recursive: true });
		await fs.writeFile(path.join(withBackup.path, '.mineshell/forge-backup/manifest.json'), '{}');
		await expect(migrateToCleanroom(withBackup, '0.5.17-alpha')).rejects.toThrow(/backup already exists/);
	});
});
