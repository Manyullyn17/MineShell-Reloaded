import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOADERS, pickerLoaderVersions } from './modloaders';
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
