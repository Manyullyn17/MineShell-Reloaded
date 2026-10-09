import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerInstance } from './db/schema';
import { dimensionLabel, isDimensionFolder } from './dimensions';
import { directorySize } from './files';
import { isLoaderInstallEntry } from './instances';
import { serverWorldName } from './packworld';
import { listSnapshots, SNAPSHOTS_DIR, worldFolders } from './snapshots';
import { mapDataSize } from './worldmap';

/**
 * Where a server's disk space goes, for the Files tab: the world split by
 * dimension, MineShell's own snapshots and backups, configs pack changes moved
 * aside, logs, mods, the loader, and everything else. Every top-level entry is
 * counted exactly once, so the groups add up to the total.
 */

export type UsageItem = {
	label: string;
	/** Relative to the server folder, for a link into Files. */
	path: string;
	bytes: number;
	note?: string;
	/** Not in the server folder (MineShell's own map render): no Files link. */
	outside?: boolean;
};

export type UsageGroup = { id: GroupId; label: string; bytes: number; items: UsageItem[] };

type GroupId = 'world' | 'map' | 'mineshell' | 'old-configs' | 'logs' | 'mods' | 'loader' | 'other';

export type Suggestion = {
	text: string;
	bytes: number;
	/** A tab or Files path to go and act; absent when the page offers the action itself. */
	href?: { tab: 'world' | 'files'; path?: string };
	action?: 'deleteOldLogs';
};

export type DiskBreakdown = { total: number; groups: UsageGroup[]; suggestions: Suggestion[]; measuredAt: number };

const GROUP_LABELS: Record<GroupId, string> = {
	world: 'World',
	map: 'World map',
	mineshell: 'Snapshots and MineShell backups',
	'old-configs': 'Configs replaced by pack changes',
	logs: 'Logs and crash reports',
	mods: 'Mods',
	loader: 'Loader and Minecraft',
	other: 'Everything else'
};

/** Archived logs and crash reports older than this are offered for deletion. */
export const OLD_LOG_DAYS = 30;

async function entries(dir: string) {
	return fs.readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function sizeOf(full: string): Promise<number> {
	const stat = await fs.lstat(full).catch(() => null);
	if (!stat) return 0;
	return stat.isDirectory() ? directorySize(full) : stat.size;
}

/**
 * One world folder split into dimensions: vanilla's DIM-1/DIM1, 1.12 mods'
 * DIM<n> and named folders (AoA_Abyss), 1.16+ `dimensions/<namespace>/<name>`.
 * The rest (the overworld's regions, player data, mod data) is one item.
 */
async function worldItems(root: string, world: string): Promise<UsageItem[]> {
	const items: UsageItem[] = [];
	const dir = path.join(root, world);
	let rest = 0;
	for (const entry of await entries(dir)) {
		const rel = path.join(world, entry.name);
		const full = path.join(root, rel);
		if (entry.isDirectory() && entry.name === 'dimensions') {
			for (const ns of await entries(full)) {
				for (const dim of ns.isDirectory() ? await entries(path.join(full, ns.name)) : []) {
					const dimRel = path.join(rel, ns.name, dim.name);
					const bytes = await sizeOf(path.join(root, dimRel));
					if (dim.isDirectory() && (await isDimensionFolder(path.join(root, dimRel)))) {
						items.push({ label: `${ns.name}:${dim.name}`, path: dimRel, bytes });
					} else rest += bytes;
				}
			}
			continue;
		}
		const bytes = await sizeOf(full);
		if (entry.isDirectory() && (await isDimensionFolder(full))) {
			items.push({ label: dimensionLabel(entry.name), path: rel, bytes });
		} else rest += bytes;
	}
	items.push({ label: 'Overworld and world data', path: world, bytes: rest, note: 'Regions, player data and what mods store in the world' });
	return items;
}

const SIBLING_LABELS: [suffix: string, label: string][] = [
	['_nether', 'The Nether'],
	['_the_end', 'The End']
];

async function oldLogFiles(root: string): Promise<{ path: string; bytes: number }[]> {
	const cutoff = Date.now() - OLD_LOG_DAYS * 86_400_000;
	const found: { path: string; bytes: number }[] = [];
	for (const [folder, pattern] of [
		['logs', /\.log\.gz$/i],
		['crash-reports', /\.txt$/i]
	] as const) {
		for (const entry of await entries(path.join(root, folder))) {
			if (!entry.isFile() || !pattern.test(entry.name)) continue;
			const rel = path.join(folder, entry.name);
			const stat = await fs.stat(path.join(root, rel)).catch(() => null);
			if (stat && stat.mtimeMs < cutoff) found.push({ path: rel, bytes: stat.size });
		}
	}
	return found;
}

/**
 * Deletes archived logs (`logs/*.log.gz`) and crash reports older than
 * OLD_LOG_DAYS. Never the running log: latest.log and debug.log are not archives.
 */
export async function deleteOldLogs(root: string): Promise<{ files: number; bytes: number }> {
	const old = await oldLogFiles(root);
	for (const file of old) await fs.rm(path.join(root, file.path), { force: true });
	return { files: old.length, bytes: old.reduce((sum, f) => sum + f.bytes, 0) };
}

/** The folders map mods keep their tiles in, at the server's top level. */
const MAP_MOD_FOLDERS: Record<string, string> = {
	bluemap: "BlueMap mod's map (bluemap)",
	dynmap: "Dynmap's map (dynmap)"
};

const MINESHELL_LABELS: Record<string, string> = {
	'forge-backup': 'Forge kept for undoing the Cleanroom migration',
	'playerdata-backups': 'Player data backups from the player editor'
};

const SUMMARY_TTL_MS = 60_000;
type Summary = { at: number; result: Promise<DiskBreakdown>; refreshing: boolean };
const summaries = new Map<string, Summary>();

/**
 * The overview (polled every few seconds) and the Files tab's bar show the
 * breakdown. Walking a big pack takes seconds, so only the first ask waits:
 * after that the last measurement is returned straight away, and once it is
 * a minute old it is redone in the background. The usage page itself always
 * measures afresh.
 */
export function recentDiskBreakdown(instance: ServerInstance): Promise<DiskBreakdown> {
	const hit = summaries.get(instance.path);
	if (!hit) {
		const result = diskBreakdown(instance);
		summaries.set(instance.path, { at: Date.now(), result, refreshing: false });
		result.catch(() => summaries.delete(instance.path));
		return result;
	}
	if (!hit.refreshing && Date.now() - hit.at > SUMMARY_TTL_MS) {
		hit.refreshing = true;
		const next = diskBreakdown(instance);
		next
			.then(() => summaries.set(instance.path, { at: Date.now(), result: next, refreshing: false }))
			.catch(() => (hit.refreshing = false));
	}
	return hit.result;
}

/** A deleted server's measurement must not show for one recreated under the same name. */
export function forgetDiskBreakdown(instancePath: string): void {
	summaries.delete(instancePath);
}

export async function diskBreakdown(instance: ServerInstance): Promise<DiskBreakdown> {
	const root = instance.path;
	const items: Record<GroupId, UsageItem[]> = {
		world: [],
		map: [],
		mineshell: [],
		'old-configs': [],
		logs: [],
		mods: [],
		loader: [],
		other: []
	};

	const worlds = new Set(await worldFolders(root));
	const levelWorld = await serverWorldName(root);
	const snapshots = new Map((await listSnapshots(root)).map((s) => [s.id, s]));
	const suggestions: Suggestion[] = [];

	for (const entry of await entries(root)) {
		const name = entry.name;
		const full = path.join(root, name);
		if (worlds.has(name)) {
			const sibling = SIBLING_LABELS.find(([suffix]) => name === `${levelWorld}${suffix}`);
			if (sibling) items.world.push({ label: sibling[1], path: name, bytes: await sizeOf(full) });
			else items.world.push(...(await worldItems(root, name)));
		} else if (name === '.mineshell') {
			for (const sub of await entries(full)) {
				const rel = path.join(name, sub.name);
				if (rel === SNAPSHOTS_DIR) {
					for (const snap of await entries(path.join(root, rel))) {
						const info = snapshots.get(snap.name);
						items.mineshell.push({
							label: info ? `Snapshot: ${info.label}` : `Unfinished snapshot ${snap.name}`,
							path: path.join(rel, snap.name),
							bytes: await sizeOf(path.join(root, rel, snap.name)),
							note: info?.pinned ? 'pinned' : undefined
						});
					}
				} else {
					items.mineshell.push({
						label: MINESHELL_LABELS[sub.name] ?? `Left over from an interrupted operation (${sub.name})`,
						path: rel,
						bytes: await sizeOf(path.join(root, rel))
					});
				}
			}
		} else if (name === 'old-configs' && entry.isDirectory()) {
			for (const sub of await entries(full)) {
				const rel = path.join(name, sub.name);
				items['old-configs'].push({ label: sub.name, path: rel, bytes: await sizeOf(path.join(root, rel)) });
			}
		} else if (MAP_MOD_FOLDERS[name] && entry.isDirectory()) {
			items.map.push({ label: MAP_MOD_FOLDERS[name], path: name, bytes: await sizeOf(full) });
		} else if (name === 'logs' || name === 'crash-reports') {
			items.logs.push({ label: name, path: name, bytes: await sizeOf(full) });
		} else if (name === 'mods') {
			items.mods.push({ label: 'mods', path: name, bytes: await sizeOf(full) });
		} else if (isLoaderInstallEntry(name)) {
			items.loader.push({ label: name, path: name, bytes: await sizeOf(full) });
		} else {
			items.other.push({ label: name, path: name, bytes: await sizeOf(full) });
		}
	}

	// The map MineShell renders (BlueMap) is kept in its own data folder, not the server's.
	const rendered = await mapDataSize(instance.id).catch(() => 0);
	if (rendered) {
		items.map.push({
			label: 'Map rendered by MineShell',
			path: '#map',
			bytes: rendered,
			note: "Kept in MineShell's data folder, not the server's; deleted with the map on the Map tab",
			outside: true
		});
	}

	const groups = (Object.keys(items) as GroupId[])
		.map((id) => ({
			id,
			label: GROUP_LABELS[id],
			bytes: items[id].reduce((sum, item) => sum + item.bytes, 0),
			items: items[id].sort((a, b) => b.bytes - a.bytes)
		}))
		.filter((group) => group.items.length > 0);

	const unpinned = items.mineshell.filter((i) => i.label.startsWith('Snapshot: ') && i.note !== 'pinned');
	if (unpinned.length) {
		suggestions.push({
			text: `${unpinned.length} unpinned world snapshot${unpinned.length === 1 ? '' : 's'}. Delete the ones you no longer need on the World tab, or keep fewer in Settings.`,
			bytes: unpinned.reduce((sum, i) => sum + i.bytes, 0),
			href: { tab: 'world' }
		});
	}
	const oldConfigs = items['old-configs'].reduce((sum, i) => sum + i.bytes, 0);
	if (items['old-configs'].length) {
		suggestions.push({
			text: `Configs that pack changes moved aside (${items['old-configs'].length} version${items['old-configs'].length === 1 ? '' : 's'}). Delete the ones you no longer need in Files.`,
			bytes: oldConfigs,
			href: { tab: 'files', path: 'old-configs' }
		});
	}
	const leftovers = items.mineshell.filter((i) => i.label.startsWith('Left over'));
	for (const leftover of leftovers) {
		suggestions.push({
			text: `${leftover.path} was left by an operation that did not finish. Check it in Files and delete it if nothing in it is needed.`,
			bytes: leftover.bytes,
			href: { tab: 'files', path: leftover.path }
		});
	}
	const oldLogs = await oldLogFiles(root);
	if (oldLogs.length) {
		suggestions.push({
			text: `${oldLogs.length} archived log${oldLogs.length === 1 ? '' : 's'} and crash report${oldLogs.length === 1 ? '' : 's'} older than ${OLD_LOG_DAYS} days.`,
			bytes: oldLogs.reduce((sum, f) => sum + f.bytes, 0),
			action: 'deleteOldLogs'
		});
	}

	return {
		total: groups.reduce((sum, g) => sum + g.bytes, 0),
		groups,
		suggestions: suggestions.sort((a, b) => b.bytes - a.bytes),
		measuredAt: Date.now()
	};
}
