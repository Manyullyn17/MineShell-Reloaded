import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOADERS } from './modloaders';
import { useRecordedHttp } from '../../../tests/helpers/http';
import { fakeProcesses, spawnCalls } from '../../../tests/helpers/process';
import { ls, tempDir } from '../../../tests/helpers/fs';

import { isLoaderInstallEntry } from './instances';

const INSTALLER = 'https://repo.cleanroommc.com/releases/com/cleanroommc/cleanroom/0.5.17/cleanroom-0.5.17-installer.jar';
const NEW_INSTALLER = 'https://repo.cleanroommc.com/releases/com/cleanroommc/cleanroom/0.7.11-alpha/cleanroom-0.7.11-alpha-installer.jar';
useRecordedHttp('none', { extra: { [INSTALLER]: () => new Response('installer'), [NEW_INSTALLER]: () => new Response('installer') } });

describe('installer-jar loaders (Forge, NeoForge, Cleanroom)', () => {
	it('runs the installer in the server folder and leaves neither it nor its log behind', async () => {
		const dir = await tempDir();
		fakeProcesses(() => {
			// What the real installer leaves: the server files, plus its log in the
			// working directory - which used to stay there for good.
			fs.writeFileSync(path.join(dir, 'cleanroom-0.5.17.jar'), 'cleanroom');
			fs.writeFileSync(path.join(dir, 'minecraft_server.1.12.2.jar'), 'vanilla');
			fs.writeFileSync(path.join(dir, 'cleanroom-0.5.17-installer.jar.log'), 'log');
			return {};
		});
		const result = await LOADERS.cleanroom.install({ dir, minecraftVersion: '1.12.2', loaderVersion: '0.5.17', javaPath: '/fake/java' });

		expect(result.loaderVersion).toBe('0.5.17');
		expect(spawnCalls[0].args).toEqual(['-jar', path.join(dir, '.mineshell', 'cleanroom-0.5.17-installer.jar'), '--installServer']);
		expect((await ls(dir)).sort()).toEqual(['.mineshell', 'cleanroom-0.5.17.jar', 'minecraft_server.1.12.2.jar']);
		expect(await ls(path.join(dir, '.mineshell'))).toEqual([]);
	});

	it("runs Cleanroom's newer installer, which has modes instead of --installServer, and launches its @argfile", async () => {
		const dir = await tempDir();
		const ARGS = 'libraries/com/cleanroommc/cleanroom/0.7.11-alpha/unix_args.txt';
		fakeProcesses((cmd, args) => {
			if (args.includes('--installServer')) return { code: 1, stderr: 'Unknown option: --installServer\nRun with --help for usage.' };
			// What 0.7.11-alpha's installer leaves (checked against the real one).
			fs.mkdirSync(path.join(dir, path.dirname(ARGS)), { recursive: true });
			fs.writeFileSync(path.join(dir, ARGS), '-cp libraries/x.jar');
			fs.writeFileSync(path.join(dir, 'user_jvm_args.txt'), '-Xmx3G\n');
			fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh');
			fs.writeFileSync(path.join(dir, 'cleanroom-server.json'), '{}');
			return {};
		});
		const result = await LOADERS.cleanroom.install({ dir, minecraftVersion: '1.12.2', loaderVersion: '0.7.11-alpha', javaPath: '/fake/java' });

		expect(spawnCalls.map((c) => c.args.slice(2))).toEqual([['--installServer'], ['server', '--dir', dir, '--version', '0.7.11-alpha', '--no-gui', '-y']]);
		expect(result).toEqual({ loaderVersion: '0.7.11-alpha', launchArgs: `@user_jvm_args.txt @${ARGS} nogui` });
		// The installer's -Xmx3G would fight MineShell's memory settings.
		expect(fs.readFileSync(path.join(dir, 'user_jvm_args.txt'), 'utf8')).not.toMatch(/^-X/m);
		// Its files are the loader's, so a loader change or a move back to Forge takes them along.
		expect((await ls(dir)).filter((name) => name !== '.mineshell' && !isLoaderInstallEntry(name))).toEqual([]);
	});

	it('does not try other options when the installer fails for another reason', async () => {
		const dir = await tempDir();
		fakeProcesses(() => ({ code: 1, stderr: 'Could not download minecraft_server.1.12.2.jar' }));
		await expect(LOADERS.cleanroom.install({ dir, minecraftVersion: '1.12.2', loaderVersion: '0.7.11-alpha', javaPath: '/fake/java' })).rejects.toThrow(
			/Could not download/
		);
		expect(spawnCalls).toHaveLength(1);
	});
});
