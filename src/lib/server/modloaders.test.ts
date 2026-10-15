import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareSemver, LOADERS, pickerLoaderVersions } from './modloaders';
import { compareVersions } from './java';
import { fetchCalls, useRecordedHttp } from '../../../tests/helpers/http';

useRecordedHttp('loaders');

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
