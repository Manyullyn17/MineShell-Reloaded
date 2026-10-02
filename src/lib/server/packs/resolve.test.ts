import { describe, expect, it } from 'vitest';
import { resolveProviderPack } from './resolve';
import { useRecordedHttp } from '../../../../tests/helpers/http';
import { zipBuffer } from '../../../../tests/helpers/fs';

// The real .mrpack is 11MB; a small stand-in with the same structure replaces it.
const MRPACK_URL = 'https://cdn.modrinth.com/data/1ocGzRHv/versions/oUYGqRIh/Vanilla%20Perfected%201.0.1.mrpack';
const mrpack = zipBuffer({
	'modrinth.index.json': JSON.stringify({
		formatVersion: 1,
		game: 'minecraft',
		versionId: '1.0.1',
		name: 'VP 1.21.11',
		dependencies: { minecraft: '1.21.11', 'fabric-loader': '0.18.4' },
		files: [{ path: 'mods/chunky.jar', hashes: { sha1: 'a' }, downloads: ['https://x/chunky.jar'] }]
	}),
	'overrides/config/x.json': '{}'
});

useRecordedHttp('resolve', { extra: { [MRPACK_URL]: () => new Response(new Uint8Array(mrpack)) } });

describe('resolveProviderPack', () => {
	it('turns a CurseForge version into the exact install the server needs', async () => {
		const { pack, projectName } = await resolveProviderPack('curseforge', '411966', '8665629');
		expect(projectName).toMatch(/MeatballCraft/i);
		expect(pack).toMatchObject({ minecraftVersion: '1.12.2', modloader: 'forge', modloaderVersion: '14.23.5.2860' });
		// overrides.zip becomes the overrides archive (configs, scripts, bundled
		// jars), never a file dropped into mods/.
		expect(pack.overridesArchive?.url).toMatch(/^https:\/\/.+forgecdn\.net\//);
		expect(pack.downloads.some((d) => d.target.endsWith('overrides.zip'))).toBe(false);
		expect(pack.downloads.length).toBeGreaterThan(300);
		expect(pack.downloads.every((d) => d.target.startsWith('mods/'))).toBe(true);
	});

	it('downloads and parses a Modrinth .mrpack', async () => {
		const { pack, projectName } = await resolveProviderPack('modrinth', 'vanilla-perfected', 'oUYGqRIh');
		expect(projectName).toBe('Vanilla Perfected');
		expect(pack).toMatchObject({ kind: 'mrpack', minecraftVersion: '1.21.11', modloader: 'fabric', modloaderVersion: '0.18.4' });
		expect(pack.downloads.map((d) => d.target)).toEqual(['mods/chunky.jar']);
		expect(pack.overrideEntries).toEqual(['overrides/config/x.json']);
	});
});
