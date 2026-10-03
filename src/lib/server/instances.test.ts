import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLoaderInstallEntry, listEntries, removeEntries } from './instances';
import { ls, tempDir } from '../../../tests/helpers/fs';

describe('isLoaderInstallEntry', () => {
	it.each([
		'libraries',
		'.fabric',
		'run.sh',
		'run.bat',
		'user_jvm_args.txt',
		'server.jar',
		'quilt-server-launch.jar',
		'minecraft_server.1.12.2.jar',
		'forge-1.12.2-14.23.5.2860.jar',
		'neoforge-21.1.252-installer.jar',
		'cleanroom-0.5.17-alpha.jar',
		// The installer writes its log to the server folder.
		'forge-1.12.2-14.23.5.2860-installer.jar.log'
	])('%s belongs to the loader install', (name) => {
		expect(isLoaderInstallEntry(name)).toBe(true);
	});

	it.each(['world', 'mods', 'config', 'server.properties', 'eula.txt', 'old-configs', '.mineshell', 'my-backup.jar', 'latest.log'])(
		'%s is never treated as loader files',
		(name) => {
			expect(isLoaderInstallEntry(name)).toBe(false);
		}
	);
});

describe('rollback cleanup', () => {
	async function instance(): Promise<string> {
		const dir = await tempDir();
		for (const name of ['libraries', 'world', 'config']) await fs.mkdir(path.join(dir, name));
		for (const name of ['server.jar', 'forge-1.12.2-1.jar', 'server.properties']) {
			await fs.writeFile(path.join(dir, name), name);
		}
		return dir;
	}

	it('lists only loader entries', async () => {
		const dir = await instance();
		expect((await listEntries(dir, isLoaderInstallEntry)).sort()).toEqual(['forge-1.12.2-1.jar', 'libraries', 'server.jar']);
	});

	it('removes matching entries but never the ones listed in keep', async () => {
		// The regression: a failure half-way through moving files aside used to
		// delete the originals that had not been moved yet.
		const dir = await instance();
		await removeEntries(dir, isLoaderInstallEntry, new Set(['libraries', 'forge-1.12.2-1.jar']));
		expect(await ls(dir)).toEqual(['config', 'forge-1.12.2-1.jar', 'libraries', 'server.properties', 'world']);
	});

	it('never touches non-loader entries', async () => {
		const dir = await instance();
		await removeEntries(dir, isLoaderInstallEntry);
		expect(await ls(dir)).toEqual(['config', 'server.properties', 'world']);
	});
});
