import { describeState } from './format.js';

export type DashboardFilterInstance = {
	name: string;
	packName: string | null;
	minecraftVersion: string;
	modloader: string;
	modloaderLabel: string;
	tags: { id: string; name: string }[];
	running: boolean;
	status: string;
	statusMessage: string | null;
	eulaAccepted: boolean;
	javaWarning: string | null;
	active: string;
	sub: string;
};

export type DashboardFilters = {
	search: string;
	status: 'all' | 'running' | 'stopped' | 'attention';
	tagIds: string[];
	minecraftVersions: string[];
	loaders: string[];
};

export function needsAttention(instance: DashboardFilterInstance): boolean {
	return (
		describeState(instance.active, instance.sub).tone === 'failed' ||
		instance.status === 'failed' ||
		!!instance.statusMessage ||
		!instance.eulaAccepted ||
		!!instance.javaWarning
	);
}

export function isStopped(instance: DashboardFilterInstance): boolean {
	const tone = describeState(instance.active, instance.sub).tone;
	return !instance.running && instance.status === 'ready' && tone !== 'busy' && tone !== 'failed';
}

/** Matches the dashboard's search and grouped filters. Values within each group are ORed. */
export function matchesDashboardFilters(instance: DashboardFilterInstance, filters: DashboardFilters): boolean {
	if (filters.status === 'running' && !instance.running) return false;
	if (filters.status === 'stopped' && !isStopped(instance)) return false;
	if (filters.status === 'attention' && !needsAttention(instance)) return false;
	if (filters.tagIds.length && !filters.tagIds.some((id) => instance.tags.some((tag) => tag.id === id))) return false;
	if (filters.minecraftVersions.length && !filters.minecraftVersions.includes(instance.minecraftVersion)) return false;
	if (filters.loaders.length && !filters.loaders.includes(instance.modloader)) return false;

	const query = filters.search.trim().toLocaleLowerCase();
	if (!query) return true;
	return [instance.name, instance.packName ?? '', instance.minecraftVersion, instance.modloaderLabel, ...instance.tags.map((tag) => tag.name)]
		.some((value) => value.toLocaleLowerCase().includes(query));
}
