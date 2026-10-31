/**
 * The installed mods table's order, set by clicking a column header: a second click on the
 * same header turns the order round. Name starts A-Z, size and added/updated start with the
 * largest and newest; a mod with no size or date (a record whose file is missing) stays at the
 * bottom both ways.
 */

export type ModSortKey = 'name' | 'size' | 'added';
export type ModSort = { key: ModSortKey; desc: boolean };

export const DEFAULT_MOD_SORT: ModSort = { key: 'name', desc: false };

/** The order after clicking `key`'s header. */
export function clickSort(sort: ModSort, key: ModSortKey): ModSort {
	return sort.key === key ? { key, desc: !sort.desc } : { key, desc: key !== 'name' };
}

type Sortable = { name: string; sizeBytes: number; addedAt: number | null };

/** `mods` (as the server lists them: by name) in `sort`'s order, as a new array. */
export function sortMods<T extends Sortable>(mods: T[], sort: ModSort): T[] {
	if (sort.key === 'name') return sort.desc ? [...mods].reverse() : [...mods];
	const value = (m: T) => (sort.key === 'size' ? m.sizeBytes || null : m.addedAt);
	return [...mods].sort((a, b) => {
		const [x, y] = [value(a), value(b)];
		if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
		return sort.desc ? y - x : x - y;
	});
}
