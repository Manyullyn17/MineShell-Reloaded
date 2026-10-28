import { describe, expect, it } from 'vitest';
import { filterVersions, isPrerelease, versionGroups } from './versionpicker';

const opts = (...values: string[]) => values.map((value) => ({ value, label: value }));

describe('filterVersions', () => {
	it('lists the versions starting with the text first, then the ones holding it', () => {
		const list = opts('21.1.200', '1.21.1', '1.20.6', '1.20.1', '1.2.5');
		expect(filterVersions(list, '1.20').map((o) => o.value)).toEqual(['1.20.6', '1.20.1', '21.1.200']);
		expect(filterVersions(opts('14.23.5.2864', '14.23.5.2860'), '2864').map((o) => o.value)).toEqual(['14.23.5.2864']);
		expect(filterVersions(list, '  ')).toBe(list);
	});

	it('matches the label too, ignoring case', () => {
		expect(filterVersions([{ value: '1.21.1', label: '1.21.1 (installed)' }], 'INSTALLED')).toHaveLength(1);
	});
});

describe('isPrerelease', () => {
	it('knows betas, alphas, pre-releases and snapshots from releases', () => {
		for (const v of ['0.29.0-beta.3', '0.7.13-alpha', '1.21.5-pre2', '1.21.5-rc1', '25w14a', '21.4.0-beta']) expect(isPrerelease(v), v).toBe(true);
		for (const v of ['1.21.1', '0.16.14', '14.23.5.2864', '21.1.265', '47.4.0']) expect(isPrerelease(v), v).toBe(false);
	});
});

describe('versionGroups', () => {
	it('puts releases apart from betas only when a list has both, the newest-first order kept', () => {
		expect(versionGroups(opts('0.29.0-beta.2', '0.29.0-beta.1', '0.28.1', '0.28.0'), '')).toEqual([
			{ heading: 'Releases', options: opts('0.28.1', '0.28.0') },
			{ heading: 'Betas and snapshots', options: opts('0.29.0-beta.2', '0.29.0-beta.1') }
		]);
		// Cleanroom: every build is an alpha, so no headings.
		expect(versionGroups(opts('0.7.13-alpha', '0.7.12-alpha'), '')).toEqual([{ heading: null, options: opts('0.7.13-alpha', '0.7.12-alpha') }]);
	});

	it('keeps "Latest" on top, and out of a filtered list', () => {
		const list = [{ value: '', label: 'Latest (0.16.14)' }, ...opts('0.16.14', '0.16.13')];
		expect(versionGroups(list, '')[0]).toEqual({ heading: null, options: [list[0]] });
		expect(versionGroups(list, '0.16.13')).toEqual([{ heading: null, options: opts('0.16.13') }]);
		expect(versionGroups(list, 'nothing')).toEqual([]);
	});
});
