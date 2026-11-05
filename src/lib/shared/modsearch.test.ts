import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import FilterSidebar from '#lib/components/FilterSidebar.svelte';
import { filtersChanged, resetFilters } from './modsearch';

describe('filtersChanged', () => {
	it('is false at the defaults, an empty group or a missing one being the same', () => {
		expect(filtersChanged({ loaders: ['fabric'], categories: [] }, { loaders: ['fabric'] })).toBe(false);
		expect(filtersChanged({}, {})).toBe(false);
	});

	it('ignores the order boxes were ticked in', () => {
		expect(filtersChanged({ loaders: ['quilt', 'fabric'] }, { loaders: ['fabric', 'quilt'] })).toBe(false);
	});

	it('sees a loader added or taken away, and a filter of another group', () => {
		expect(filtersChanged({ loaders: ['fabric', 'forge'] }, { loaders: ['fabric'] })).toBe(true);
		expect(filtersChanged({ loaders: [] }, { loaders: ['fabric'] })).toBe(true);
		expect(filtersChanged({ loaders: ['fabric'], categories: ['magic'] }, { loaders: ['fabric'] })).toBe(true);
	});
});

describe('resetFilters', () => {
	it('gives a copy, so ticking boxes afterwards cannot change the defaults', () => {
		const defaults = { loaders: ['fabric'] };
		const reset = resetFilters(defaults);
		expect(reset).toEqual(defaults);
		reset.loaders.push('forge');
		expect(defaults.loaders).toEqual(['fabric']);
	});
});

describe('the filter sidebar', () => {
	const body = (props: Record<string, unknown>) => render(FilterSidebar, { props }).body;

	it('offers Reset once filters left defaults, and nothing at the defaults', () => {
		const defaults = { loaders: ['fabric'] };
		expect(body({ selected: { loaders: ['fabric', 'forge'] }, defaults })).toContain('Reset');
		expect(body({ selected: { loaders: [] }, defaults })).toContain('Reset');
		expect(body({ selected: { loaders: ['fabric'] }, defaults })).not.toMatch(/Reset|Clear/);
	});

	it('offers Clear with a count when there are no defaults', () => {
		expect(body({ selected: { categories: ['magic', 'tech'] } })).toMatch(/Clear \(2\)/);
		expect(body({ selected: {} })).not.toMatch(/Reset|Clear/);
	});
});
