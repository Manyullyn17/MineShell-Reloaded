import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOADERS } from './modloaders';
import { useRecordedHttp } from '../../../tests/helpers/http';
import { fakeProcesses, spawnCalls } from '../../../tests/helpers/process';
import { ls, tempDir } from '../../../tests/helpers/fs';

const META = 'https://meta.fabricmc.net/v2';
useRecordedHttp('none', {
	extra: {
		[`${META}/versions/loader/1.16.5`]: () => Response.json([{ loader: { version: '0.12.12' } }, { loader: { version: '0.11.7' } }]),
		[`${META}/versions/installer`]: () => Response.json([{ version: '1.1.2', stable: true }]),
		'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.2/fabric-installer-1.1.2.jar': () => new Response('installer'),
		[`${META}/versions/loader/1.16.5/0.12.12/1.1.2/server/jar`]: () => new Response('launcher')
	}
});

describe('Fabric install', () => {
	it('runs the full installer for loaders before 0.12, which the server-jar endpoint refuses', async () => {
		const dir = await tempDir();
		fakeProcesses((cmd, args) => {
			// What the real installer leaves behind (checked against Fabric's installer 1.1.2).
			const target = args[args.indexOf('-dir') + 1];
			fs.writeFileSync(path.join(target, 'fabric-server-launch.jar'), 'launch');
			fs.writeFileSync(path.join(target, 'server.jar'), 'vanilla');
			return {};
		});
		const result = await LOADERS.fabric.install({ dir, minecraftVersion: '1.16.5', loaderVersion: '0.11.7', javaPath: '/fake/java' });

		expect(result).toEqual({ launchArgs: '-jar fabric-server-launch.jar nogui', loaderVersion: '0.11.7' });
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0].cmd).toBe('/fake/java');
		expect(spawnCalls[0].args).toEqual(expect.arrayContaining(['server', '-mcversion', '1.16.5', '-loader', '0.11.7', '-downloadMinecraft', '-dir', dir]));
		// The installer itself is not left lying around.
		expect(await ls(path.join(dir, '.mineshell'))).toEqual([]);
	});

	it('downloads the ready-made launcher for 0.12 and newer, without running anything', async () => {
		const dir = await tempDir();
		fakeProcesses(() => ({}));
		const result = await LOADERS.fabric.install({ dir, minecraftVersion: '1.16.5', loaderVersion: '0.12.12', javaPath: '/fake/java' });
		expect(result).toEqual({ launchArgs: '-jar server.jar nogui', loaderVersion: '0.12.12' });
		expect(spawnCalls).toEqual([]);
		expect(fs.readFileSync(path.join(dir, 'server.jar'), 'utf8')).toBe('launcher');
	});

	it('reports an installer failure', async () => {
		const dir = await tempDir();
		fakeProcesses(() => ({ code: 1, stderr: 'Failed to download Minecraft' }));
		await expect(
			LOADERS.fabric.install({ dir, minecraftVersion: '1.16.5', loaderVersion: '0.11.7', javaPath: '/fake/java' })
		).rejects.toThrow(/Fabric installer failed: Failed to download Minecraft/);
	});
});
