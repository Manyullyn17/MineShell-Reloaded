import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { compareSemver, forgetMojangManifest, LOADERS, neoforgePrefix, pickerLoaderVersions } from './modloaders';
import { compareVersions } from './java';
import { fetchCalls, useRecordedHttp } from '../../../tests/helpers/http';

// Mojang's manifest, cut down: releases with snapshots between them, down to 1.0.
const RELEASES = ['26.3', '1.21.11', '1.10', '1.3.1', '1.2.5', '1.2.4', '1.1', '1.0'];
useRecordedHttp('loaders', {
	extra: {
		'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json': () =>
			Response.json({
				latest: { release: '26.3', snapshot: '26w44a' },
				versions: [{ id: '26w44a', type: 'snapshot' }, ...RELEASES.map((id) => ({ id, type: 'release' }))]
			})
	}
});
// Files in the shared project share modules: the cut-down manifest must not reach another file.
beforeAll(forgetMojangManifest);
afterAll(forgetMojangManifest);

describe('loader version lists', () => {
	it('Cleanroom: only for 1.12.2, newest first', async () => {
		const versions = await LOADERS.cleanroom.listLoaderVersions('1.12.2');
		expect(versions).toEqual(expect.arrayContaining(['0.4.4-alpha', '0.5.17-alpha']));
		expect(versions.indexOf('0.5.17-alpha')).toBeLessThan(versions.indexOf('0.4.4-alpha'));
		expect(await LOADERS.cleanroom.listLoaderVersions('1.16.5')).toEqual([]);
		expect(await LOADERS.cleanroom.listGameVersions()).toEqual(['1.12.2']);
	});

	it('Forge: builds for the requested Minecraft version, without the version prefix', async () => {
		const versions = await LOADERS.forge.listLoaderVersions('1.12.2');
		expect(versions).toContain('14.23.5.2860');
		expect(versions.every((v) => !v.startsWith('1.12'))).toBe(true);
		expect(compareVersions(versions[0], versions[versions.length - 1])).toBeGreaterThan(0);
		// The metadata is not in order (2864-2861, then 14.23.0.2486 onwards).
		for (let i = 1; i < versions.length; i++) expect(compareVersions(versions[i - 1], versions[i])).toBeGreaterThanOrEqual(0);
	});

	it('NeoForge: maps 1.21.1 to 21.1.x and skips betas', async () => {
		const versions = await LOADERS.neoforge.listLoaderVersions('1.21.1');
		expect(versions.length).toBeGreaterThan(10);
		expect(versions.every((v) => v.startsWith('21.1.') && !v.includes('beta'))).toBe(true);
		expect(versions).toContain('21.1.252');
	});

	// Minecraft's year versions (26.1, 26.3) came with NeoForge builds named after them whole:
	// 26.3 asked for "3.0." and found nothing.
	it('NeoForge: maps year versions whole, 26.3 to 26.3.0.x, betas only where there is no release, never snapshot alphas', async () => {
		expect([neoforgePrefix('1.21.1'), neoforgePrefix('1.20.2'), neoforgePrefix('1.21'), neoforgePrefix('26.3'), neoforgePrefix('26.1.2')]).toEqual([
			'21.1.',
			'20.2.',
			'21.0.',
			'26.3.0.',
			'26.1.2.'
		]);
		const releases = await LOADERS.neoforge.listLoaderVersions('26.1.2');
		expect(releases.length).toBeGreaterThan(10);
		expect(releases.every((v) => /^26\.1\.2\.\d+$/.test(v))).toBe(true);
		expect(compareVersions(releases[0], releases[releases.length - 1])).toBeGreaterThan(0);
		// With no release yet (26.3 when recorded), its betas, still without the alphas.
		const betas = await LOADERS.neoforge.listLoaderVersions('26.3');
		expect(betas[0]).toBe('26.3.0.43-beta');
		expect(betas.every((v) => /^26\.3\.0\.\d+-beta$/.test(v))).toBe(true);
		expect(await LOADERS.neoforge.listLoaderVersions('26.1')).toHaveLength(18);
	});

	// Leaving Cleanroom left 1.12.2 picked, and these answered 400 and 404: the new-server form
	// said the metadata server could not be reached.
	it('Fabric and Quilt: no builds, not a failure, for a Minecraft version they do not have', async () => {
		expect(await LOADERS.fabric.listLoaderVersions('1.12.2')).toEqual([]);
		expect(await LOADERS.quilt.listLoaderVersions('1.12.2')).toEqual([]);
	});

	it('Fabric and Quilt: loader builds for a game version', async () => {
		expect(await LOADERS.fabric.listLoaderVersions('1.21.1')).toEqual(expect.arrayContaining(['0.16.0', '0.19.5']));
		expect((await LOADERS.quilt.listLoaderVersions('1.20.1')).length).toBeGreaterThan(0);
	});

	// Quilt's meta answers 0.20.0-beta.9 first and 0.24.0 sixth: a new server got that beta, and
	// update checks (newest first) offered betas below the installed build.
	it('Quilt: newest first, though its meta lists them in no order', async () => {
		const versions = await LOADERS.quilt.listLoaderVersions('1.20.1');
		expect(versions.slice(0, 3)).toEqual(['0.31.0-beta.4', '0.31.0-beta.3', '0.31.0-beta.2']);
		expect(versions.indexOf('0.24.0')).toBeLessThan(versions.indexOf('0.20.0-beta.9'));
		for (let i = 1; i < versions.length; i++) expect(compareSemver(versions[i - 1], versions[i])).toBeGreaterThanOrEqual(0);
	});

	it('orders versions with pre-releases below their release', () => {
		const sorted = ['0.20.0-beta.10', '0.20.1-beta.1', '0.20.0', '0.19.5', '0.20.0-beta.9', '0.20.0-rc.1'].sort((a, b) => compareSemver(b, a));
		expect(sorted).toEqual(['0.20.1-beta.1', '0.20.0', '0.20.0-rc.1', '0.20.0-beta.10', '0.20.0-beta.9', '0.19.5']);
	});
});

describe('Minecraft versions', () => {
	// Add a server offered the newest 60 only, which ended at 1.10 although Forge and vanilla
	// go much further back.
	it('lists every release down to 1.2.5, the oldest Mojang has a server jar for', async () => {
		expect(await LOADERS.vanilla.listGameVersions()).toEqual(['26.3', '1.21.11', '1.10', '1.3.1', '1.2.5']);
		expect(await LOADERS.forge.listGameVersions()).toEqual(['26.3', '1.21.11', '1.10', '1.3.1', '1.2.5']);
	});
});

describe('version lists for pickers', () => {
	afterEach(() => vi.useRealTimers());

	it('answers from memory, refreshing behind the answer once 10 min old', async () => {
		// Settings fetched the loader's list on every open: up to 0.6 s for Forge's.
		vi.useFakeTimers({ toFake: ['Date'] });
		const first = await pickerLoaderVersions('neoforge', '1.21.1');
		const fetched = fetchCalls.length;
		expect(await pickerLoaderVersions('neoforge', '1.21.1')).toBe(first);
		expect(fetchCalls).toHaveLength(fetched);

		vi.setSystemTime(Date.now() + 11 * 60_000);
		expect(await pickerLoaderVersions('neoforge', '1.21.1')).toBe(first);
		expect(fetchCalls).toHaveLength(fetched + 1);
	});
});
