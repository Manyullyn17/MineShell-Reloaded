import { describe, expect, it } from 'vitest';
import { matchesDashboardFilters, needsAttention, type DashboardFilterInstance, type DashboardFilters } from './dashboard-filters.js';

const base: DashboardFilterInstance = {
	name: 'Survival',
	packName: 'Better Pack',
	minecraftVersion: '1.21.1',
	modloader: 'fabric',
	modloaderLabel: 'Fabric',
	tags: [{ id: 'nightly', name: 'Nightly' }, { id: 'friends', name: 'Friends' }],
	running: false,
	status: 'ready',
	statusMessage: null,
	eulaAccepted: true,
	javaWarning: null,
	active: 'inactive',
	sub: 'dead'
};

const filters = (overrides: Partial<DashboardFilters> = {}): DashboardFilters => ({
	search: '',
	status: 'all',
	tagIds: [],
	minecraftVersions: [],
	loaders: [],
	...overrides
});

describe('dashboard filters', () => {
	it('matches any selected value within a group and requires every selected group', () => {
		expect(matchesDashboardFilters(base, filters({ tagIds: ['missing', 'friends'], loaders: ['forge', 'fabric'] }))).toBe(true);
		expect(matchesDashboardFilters(base, filters({ tagIds: ['nightly'], minecraftVersions: ['1.20.1'] }))).toBe(false);
	});

	it('searches server, pack, version, loader, and tag names without case sensitivity', () => {
		for (const search of ['SURV', 'better pack', '1.21.1', 'fabric', 'FRIENDS']) {
			expect(matchesDashboardFilters(base, filters({ search }))).toBe(true);
		}
		expect(matchesDashboardFilters(base, filters({ search: 'missing' }))).toBe(false);
	});

	it('matches running, stopped, and attention statuses', () => {
		expect(matchesDashboardFilters(base, filters({ status: 'stopped' }))).toBe(true);
		expect(matchesDashboardFilters(base, filters({ status: 'running' }))).toBe(false);
		expect(needsAttention(base)).toBe(false);
		expect(needsAttention({ ...base, statusMessage: 'Needs setup' })).toBe(true);
		expect(matchesDashboardFilters({ ...base, statusMessage: 'Needs setup' }, filters({ status: 'attention' }))).toBe(true);
	});
});
