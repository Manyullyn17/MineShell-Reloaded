/** Shared by the two catalog searches, Add mods and Add a server's pack browser. */

/** Typing or changing a filter searches by itself once nothing has changed for this long. */
export const SEARCH_DELAY_MS = 500;

export type FilterSelection = Record<string, string[]>;

/** Whether the filters differ from where they start, whatever order the boxes were ticked in. */
export function filtersChanged(selected: FilterSelection, defaults: FilterSelection): boolean {
	return [...new Set([...Object.keys(selected), ...Object.keys(defaults)])].some((group) => {
		const picked = new Set(selected[group] ?? []);
		const start = new Set(defaults[group] ?? []);
		return picked.size !== start.size || [...picked].some((value) => !start.has(value));
	});
}

/** A copy of the defaults to put back: the selection is edited, the defaults stay as they are. */
export function resetFilters(defaults: FilterSelection): FilterSelection {
	return Object.fromEntries(Object.entries(defaults).map(([group, values]) => [group, [...values]]));
}
