import { describe, expect, it } from 'vitest';
import { clickSort, DEFAULT_MOD_SORT, sortMods } from './modsort';

const mods = [
	{ name: 'Alpha', sizeBytes: 200, addedAt: 3 },
	{ name: 'Beta', sizeBytes: 0, addedAt: null },
	{ name: 'Gamma', sizeBytes: 900, addedAt: 1 },
	{ name: 'Delta', sizeBytes: 50, addedAt: 7 }
];
const names = (list: typeof mods) => list.map((m) => m.name);

describe('the installed mods table order', () => {
	it('starts by name as listed, A-Z', () => {
		expect(names(sortMods(mods, DEFAULT_MOD_SORT))).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
	});

	// The "Sort by" select sorted one way only: no smallest mods, no oldest additions.
	it('a second click on a header turns the order round', () => {
		const size = clickSort(DEFAULT_MOD_SORT, 'size');
		expect(size).toEqual({ key: 'size', desc: true });
		expect(names(sortMods(mods, size))).toEqual(['Gamma', 'Alpha', 'Delta', 'Beta']);
		expect(names(sortMods(mods, clickSort(size, 'size')))).toEqual(['Delta', 'Alpha', 'Gamma', 'Beta']);
		expect(names(sortMods(mods, clickSort(DEFAULT_MOD_SORT, 'name')))).toEqual(['Delta', 'Gamma', 'Beta', 'Alpha']);
	});

	it('newest first by date, a mod without one last both ways', () => {
		const added = clickSort(DEFAULT_MOD_SORT, 'added');
		expect(names(sortMods(mods, added))).toEqual(['Delta', 'Alpha', 'Gamma', 'Beta']);
		expect(names(sortMods(mods, clickSort(added, 'added')))).toEqual(['Gamma', 'Alpha', 'Delta', 'Beta']);
	});

	it('another header starts its own way', () => {
		expect(clickSort({ key: 'size', desc: false }, 'name')).toEqual({ key: 'name', desc: false });
		expect(clickSort({ key: 'name', desc: true }, 'added')).toEqual({ key: 'added', desc: true });
	});
});
