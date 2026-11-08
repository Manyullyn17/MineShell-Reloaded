import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configFilesByMod } from './modconfigs';
import { tempDir } from '../../../tests/helpers/fs';

async function serverWith(files: string[]): Promise<string> {
	const root = await tempDir('modconfigs-');
	for (const file of files) {
		await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await fs.writeFile(path.join(root, file), '');
	}
	return root;
}

describe('configFilesByMod', () => {
	it('finds a mod’s configs by its ids and names, the world’s own first', async () => {
		const root = await serverWith([
			'server.properties',
			'config/jei-client.toml',
			'config/create-common.toml',
			'config/Mekanism/general.toml',
			'config/Mekanism/tiers.toml',
			'config/AkashicTome.cfg',
			'world/serverconfig/create-server.toml',
			'defaultconfigs/create-server.toml',
			'config/unrelated.json',
			'config/create-common.toml.bak',
			'config/fml.toml'
		]);
		await fs.writeFile(path.join(root, 'server.properties'), 'level-name=world\n');
		const found = await configFilesByMod(root, [
			{ fileName: 'create-1.0.jar', ids: ['create'], names: ['Create'] },
			{ fileName: 'jei.jar', ids: ['jei'], names: ['Just Enough Items'] },
			{ fileName: 'Mekanism.jar', ids: ['mekanism'], names: ['Mekanism'] },
			{ fileName: 'AkashicTome.jar', ids: ['akashictome'], names: ['Akashic Tome'] },
			{ fileName: 'neoforge-shim.jar', ids: ['neoforge', 'fml'], names: [] },
			{ fileName: 'quiet.jar', ids: ['quiet'], names: ['Quiet'] }
		]);
		expect(found).toEqual({
			'create-1.0.jar': ['world/serverconfig/create-server.toml', 'config/create-common.toml', 'defaultconfigs/create-server.toml'],
			'jei.jar': ['config/jei-client.toml'],
			'Mekanism.jar': ['config/Mekanism/general.toml', 'config/Mekanism/tiers.toml'],
			'AkashicTome.jar': ['config/AkashicTome.cfg']
		});
	});
});
