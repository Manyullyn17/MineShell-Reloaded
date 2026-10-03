import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOADERS } from './modloaders';
import { useRecordedHttp } from '../../../tests/helpers/http';
import { fakeProcesses, spawnCalls } from '../../../tests/helpers/process';
import { ls, tempDir } from '../../../tests/helpers/fs';

const INSTALLER = 'https://repo.cleanroommc.com/releases/com/cleanroommc/cleanroom/0.5.17/cleanroom-0.5.17-installer.jar';
useRecordedHttp('none', { extra: { [INSTALLER]: () => new Response('installer') } });

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
});
