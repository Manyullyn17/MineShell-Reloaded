import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOverrides, curseforgeCdnUrl, curseforgeUrls, packFromFileList, parsePack } from './index';
import { ls, tempDir, zipBuffer } from '../../../../tests/helpers/fs';

describe('packFromFileList (modpacks.ch file lists)', () => {
	const files = [
		{ path: './mods/', name: 'jei.jar', url: 'https://x/jei.jar', sha1: 'aa' },
		{ path: './config/', name: 'jei.cfg', url: 'https://x/jei.cfg' },
		{ path: './', name: 'overrides.zip', url: 'https://x/overrides.zip', sha1: 'bb' }
	];
	const pack = packFromFileList({
		name: 'P',
		version: '1',
		minecraftVersion: '1.12.2',
		modloader: 'forge',
		modloaderVersion: '14.23.5.2860',
		files
	});

	it('keeps each file in its own folder instead of dumping everything into mods/', () => {
		expect(pack.downloads.map((d) => d.target)).toEqual(['mods/jei.jar', 'config/jei.cfg']);
	});

	it('treats a root overrides.zip as the overrides archive, not as a file to install', () => {
		expect(pack.overridesArchive).toEqual({
			url: 'https://x/overrides.zip',
			hash: { algo: 'sha1', value: 'bb' }
		});
		expect(pack.downloads.some((d) => d.target.endsWith('overrides.zip'))).toBe(false);
	});

	it('only treats overrides.zip at the root that way', () => {
		const nested = packFromFileList({
			...pack,
			files: [{ path: './mods/', name: 'overrides.zip', url: 'https://x/o.zip' }]
		});
		expect(nested.overridesArchive).toBeNull();
		expect(nested.downloads.map((d) => d.target)).toEqual(['mods/overrides.zip']);
	});

	it('keeps entries without a URL, so they are looked up or reported instead of silently dropped', () => {
		const listed = packFromFileList({
			...pack,
			files: [
				{ path: './mods/', name: 'cf.jar', url: '', curseforge: { projectId: '10', fileId: '2000' } },
				{ path: './resourcepacks/', name: 'plain.zip', url: null }
			]
		});
		expect(listed.downloads).toMatchObject([
			{ target: 'mods/cf.jar', urls: [], curseforge: { projectId: 10, fileId: 2000 } },
			{ target: 'resourcepacks/plain.zip', urls: [] }
		]);
	});

	it('gives CurseForge files the CDN behind the edge redirector as a second source', () => {
		const listed = packFromFileList({
			...pack,
			files: [{ path: './mods/', name: 'A B.jar', url: 'https://edge.forgecdn.net/files/3408/276/A%20B.jar', curseforge: { projectId: '1', fileId: '3408276' } }]
		});
		expect(listed.downloads[0].urls).toEqual([
			'https://edge.forgecdn.net/files/3408/276/A%20B.jar',
			'https://mediafilez.forgecdn.net/files/3408/276/A%20B.jar'
		]);
	});
});

describe('curseforgeUrls', () => {
	it('does not list the CDN twice when the file is already there, however its name is escaped', () => {
		const url = 'https://mediafilez.forgecdn.net/files/5951/859/%5bMC%5d%20Patch.jar';
		expect(curseforgeUrls(url, 5951859, '[MC] Patch.jar')).toEqual([url]);
	});
});

describe('parsePack', () => {
	it('reads a Modrinth .mrpack, skipping server-unsupported files', () => {
		const pack = parsePack(
			zipBuffer({
				'modrinth.index.json': JSON.stringify({
					formatVersion: 1,
					game: 'minecraft',
					versionId: '1.0',
					name: 'Test',
					dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.0' },
					files: [
						{ path: 'mods/a.jar', hashes: { sha1: 'a1' }, downloads: ['https://x/a'] },
						{ path: 'mods/shader.jar', hashes: { sha1: 's1' }, downloads: ['https://x/s'], env: { client: 'required', server: 'unsupported' } },
						{ path: 'mods/opt.jar', hashes: { sha512: 'o5' }, downloads: ['https://x/o'], env: { client: 'required', server: 'optional' } }
					]
				}),
				'overrides/config/a.toml': 'x=1'
			})
		);
		expect(pack).toMatchObject({ kind: 'mrpack', minecraftVersion: '1.21.1', modloader: 'fabric', modloaderVersion: '0.16.0' });
		expect(pack.downloads.map((d) => [d.target, d.required])).toEqual([
			['mods/a.jar', true],
			['mods/opt.jar', false]
		]);
		expect(pack.overrideEntries).toEqual(['overrides/config/a.toml']);
	});

	it('reads a CurseForge manifest and its loader id', () => {
		const pack = parsePack(
			zipBuffer({
				'manifest.json': JSON.stringify({
					minecraft: { version: '1.12.2', modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }] },
					name: 'CF',
					version: '2',
					files: [{ projectID: 1, fileID: 2, required: true }],
					overrides: 'overrides'
				})
			})
		);
		expect(pack).toMatchObject({ kind: 'curseforge', modloader: 'forge', modloaderVersion: '14.23.5.2860' });
		expect(pack.downloads[0].curseforge).toEqual({ projectId: 1, fileId: 2 });
	});

	it('rejects archives that are neither', () => {
		expect(() => parsePack(zipBuffer({ 'readme.txt': 'hi' }))).toThrow(/Unrecognised archive/);
	});
});

describe('applyOverrides', () => {
	it('lets server-overrides win and never writes outside the instance', async () => {
		const pack = parsePack(
			zipBuffer({
				'modrinth.index.json': JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1', name: 'T', dependencies: { minecraft: '1.21.1' }, files: [] }),
				'server-overrides/config/a.toml': 'server',
				'overrides/config/a.toml': 'shared',
				'overrides/../escape.txt': 'nope'
			})
		);
		const dir = await tempDir();
		await applyOverrides(pack, dir);
		expect(await fs.readFile(path.join(dir, 'config/a.toml'), 'utf8')).toBe('server');
		expect(await ls(path.dirname(dir))).not.toContain('escape.txt');
		expect(await ls(dir)).toEqual(['config']);
	});
});

describe('curseforgeCdnUrl', () => {
	it('splits the file id into thousands and the rest', () => {
		expect(curseforgeCdnUrl(7492878, 'sfm.jar')).toBe('https://edge.forgecdn.net/files/7492/878/sfm.jar');
		// Six-digit ids: previously cut after four digits (files/2270/83).
		expect(curseforgeCdnUrl(227083, 'Baubles 1.jar')).toBe('https://edge.forgecdn.net/files/227/83/Baubles%201.jar');
	});
});
