import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db';
import { instanceMods, type ServerInstance } from './db/schema';
import {
	audit,
	InstanceError,
	requireInstance,
	requireStopped,
	setStatus,
	syncUnit
} from './instances';
import {
	bestVersion,
	getModProvider,
	installModVersion,
	listInstanceMods,
	modsDir,
	setModEnabled,
	setModLocked,
	type ModRow,
	type ProjectVersion
} from './mods';
import { latestVersionsFromHashes } from './mods/modrinth';
import { hashFile } from './download';
import { getLoader, LOADER_FALLBACKS, type ModloaderId } from './modloaders';
import { beginOperation, commitOperation, endOperation, OperationInProgressError, type Journal } from './operations';
import { startTask, type TaskHandle } from './tasks';
import { snapshotStep } from './snapshots';

/**
 * Updating mods outside a pack version change: all of them at once ("Update
 * mods"), or one mod moved to any version, older ones included.
 *
 * Only mods tracked as Modrinth or CurseForge can be looked up; locked ones
 * are left out of "update all". An update is a version newer than the one
 * installed, and someone on a release is not moved onto a beta.
 *
 * Applying is journalled (`mod-update`): old jars move into a staging folder
 * and the mod records are kept in the journal, so a failure - or MineShell
 * stopping - puts both back exactly.
 */

export type ModUpdateJournal = Extract<Journal, { kind: 'mod-update' }>;

type Filter = { minecraftVersion: string; loaders: string[] };

function filterFor(instance: ServerInstance): Filter {
	const loader = getLoader(instance.modloader);
	const catalog = loader.catalogLoader ?? loader.id;
	return {
		minecraftVersion: instance.minecraftVersion,
		loaders: [catalog, ...(LOADER_FALLBACKS[instance.modloader as ModloaderId] ?? [])]
	};
}

const timeOf = (v: ProjectVersion) => Date.parse(v.datePublished ?? '') || 0;

/**
 * The version to update to from `versions` (one mod's, compatible ones), or
 * null when the installed one is the newest worth having. Without the
 * installed version in the list nothing is known about its age, so the best
 * release is offered when it differs by name.
 */
export function pickUpdate(versions: ProjectVersion[], current: { versionId: string | null; version: string | null }): ProjectVersion | null {
	const installed = versions.find((v) => v.id === current.versionId);
	if (!installed) {
		const best = bestVersion(versions.filter((v) => v.channel === 'release')) ?? null;
		return best && best.versionNumber !== current.version ? best : null;
	}
	const newer = versions.filter((v) => timeOf(v) > timeOf(installed));
	const pool = installed.channel === 'release' ? newer.filter((v) => v.channel === 'release') : newer;
	return bestVersion(pool);
}

export type ModUpdate = {
	fileName: string;
	name: string;
	source: string;
	currentVersion: string | null;
	targetVersionId: string;
	targetVersion: string;
	channel: string;
	enabled: boolean;
	fromPack: boolean;
};

export type UpdateCheck = {
	updates: ModUpdate[];
	upToDate: number;
	skipped: { fileName: string; name: string; reason: string }[];
};

const LOOKUP_CONCURRENCY = 6;

async function eachLimited<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
	const queue = [...items];
	await Promise.all(
		Array.from({ length: Math.min(LOOKUP_CONCURRENCY, queue.length) }, async () => {
			for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item);
		})
	);
}

function trackable(row: ModRow): boolean {
	return (row.source === 'modrinth' || row.source === 'curseforge') && !!row.slug && !row.missing;
}

/** Which mods have a newer compatible version. */
export async function checkModUpdates(instance: ServerInstance): Promise<UpdateCheck> {
	const filter = filterFor(instance);
	const rows = (await listInstanceMods(instance)).filter((r) => !r.missing);
	const result: UpdateCheck = { updates: [], upToDate: 0, skipped: [] };
	const candidates: ModRow[] = [];
	for (const row of rows) {
		if (!trackable(row)) result.skipped.push({ fileName: row.fileName, name: row.name, reason: 'Not from Modrinth or CurseForge' });
		else if (row.locked) result.skipped.push({ fileName: row.fileName, name: row.name, reason: 'Locked' });
		else candidates.push(row);
	}

	// Modrinth answers "is there anything newer" for 100 files per request; only
	// mods with something newer get their version list read.
	const modrinth = candidates.filter((r) => r.source === 'modrinth');
	const hashes = new Map<string, ModRow>();
	for (const row of modrinth) {
		hashes.set(await hashFile(path.join(modsDir(instance.path), row.fileName), 'sha512'), row);
	}
	const latest = await latestVersionsFromHashes([...hashes.keys()], { loaders: filter.loaders, gameVersions: [filter.minecraftVersion] });
	const toList: ModRow[] = candidates.filter((r) => r.source === 'curseforge');
	for (const [hash, row] of hashes) {
		const newest = latest.get(hash);
		const installedFile = newest?.files.some((f) => f.hash?.value === hash);
		if (!newest) result.skipped.push({ fileName: row.fileName, name: row.name, reason: `No version for ${filter.loaders[0]} ${filter.minecraftVersion}` });
		else if (newest.id === row.versionId || installedFile) result.upToDate++;
		else toList.push(row);
	}

	await eachLimited(toList, async (row) => {
		try {
			const versions = await compatibleVersions(row, filter);
			const target = pickUpdate(versions, row);
			if (!target) {
				result.upToDate++;
				return;
			}
			result.updates.push({
				fileName: row.fileName,
				name: row.name,
				source: row.source,
				currentVersion: row.version,
				targetVersionId: target.id,
				targetVersion: target.versionNumber,
				channel: target.channel,
				enabled: row.enabled,
				fromPack: row.fromPack
			});
		} catch (err) {
			result.skipped.push({ fileName: row.fileName, name: row.name, reason: `Lookup failed: ${err instanceof Error ? err.message : 'unknown error'}` });
		}
	});
	result.updates.sort((a, b) => a.name.localeCompare(b.name));
	result.skipped.sort((a, b) => a.name.localeCompare(b.name));
	return result;
}

/** Every version of a mod that runs on this server, newest first, across the loaders it accepts. */
async function compatibleVersions(row: ModRow, filter: Filter): Promise<ProjectVersion[]> {
	const provider = getModProvider(row.source);
	const seen = new Map<string, ProjectVersion>();
	for (const loader of filter.loaders) {
		for (const v of await provider.listVersions(row.slug!, { minecraftVersion: filter.minecraftVersion, loader })) {
			if (!seen.has(v.id)) seen.set(v.id, v);
		}
		// The server's own loader is enough when it has builds; fallbacks only widen an empty list.
		if (seen.size) break;
	}
	return [...seen.values()].sort((a, b) => timeOf(b) - timeOf(a));
}

export type VersionChoice = { id: string; versionNumber: string; channel: string; datePublished: string | null; installed: boolean };

/** The versions one mod can be switched to, for the version picker. */
export async function listModVersions(instance: ServerInstance, fileName: string): Promise<{ name: string; versions: VersionChoice[] }> {
	const row = (await listInstanceMods(instance)).find((r) => r.fileName === fileName);
	if (!row || !trackable(row)) throw new InstanceError('Only mods from Modrinth or CurseForge can change version here.');
	const versions = await compatibleVersions(row, filterFor(instance));
	return {
		name: row.name,
		versions: versions.map((v) => ({
			id: v.id,
			versionNumber: v.versionNumber,
			channel: v.channel,
			datePublished: v.datePublished,
			installed: v.id === row.versionId
		}))
	};
}

// --------------------------------------------------------------- apply ---

export type VersionChange = { fileName: string; versionId: string };

/**
 * Restore mods/ and the mod records from a mod-update journal: files the
 * change added go, staged originals return, the records are rewritten as
 * they were. Shared by the in-process rollback and recovery.
 */
export async function restoreModUpdate(instanceId: string, root: string, journal: ModUpdateJournal): Promise<void> {
	const mods = modsDir(root);
	const staging = path.join(root, journal.staging);
	const before = new Set(journal.modsBefore);
	for (const name of await fs.readdir(mods).catch(() => [] as string[])) {
		if (!before.has(name)) await fs.rm(path.join(mods, name), { force: true });
	}
	for (const name of await fs.readdir(staging).catch(() => [] as string[])) {
		await fs.rename(path.join(staging, name), path.join(mods, name));
	}
	db.transaction((tx) => {
		tx.delete(instanceMods).where(eq(instanceMods.instanceId, instanceId)).run();
		for (const row of journal.rowsBefore) tx.insert(instanceMods).values(row as typeof instanceMods.$inferInsert).run();
	});
	await fs.rm(staging, { recursive: true, force: true });
}

/**
 * Move mods to the given versions. `snapshot` copies the world first.
 * Versions are looked up before anything moves, so an unreachable source
 * fails the change with nothing touched.
 */
export async function changeModVersions(
	instance: ServerInstance,
	changes: VersionChange[],
	opts: { snapshot: boolean; label: string }
): Promise<string> {
	if (!changes.length) throw new InstanceError('Nothing to update.');
	await requireStopped(instance);
	const rows = new Map((await listInstanceMods(instance)).map((r) => [r.fileName, r]));
	for (const change of changes) {
		const row = rows.get(change.fileName);
		if (!row || !trackable(row)) throw new InstanceError(`${change.fileName} is not a Modrinth or CurseForge mod in this server.`);
	}

	const root = instance.path;
	const journal: ModUpdateJournal = {
		kind: 'mod-update',
		staging: path.join('.mineshell', `mod-update-${Date.now()}`),
		modsBefore: await fs.readdir(modsDir(root)).catch(() => [] as string[]),
		rowsBefore: db.select().from(instanceMods).where(eq(instanceMods.instanceId, instance.id)).all()
	};
	try {
		beginOperation(instance.id, journal);
	} catch (err) {
		if (err instanceof OperationInProgressError) throw new InstanceError(err.message);
		throw err;
	}
	setStatus(instance.id, 'provisioning', opts.label);
	return startTask({ label: `${opts.label}: ${instance.name}`, instanceId: instance.id }, (task) =>
		applyChanges(instance, changes, rows, journal, opts, task)
	);
}

async function applyChanges(
	instance: ServerInstance,
	changes: VersionChange[],
	rows: Map<string, ModRow>,
	journal: ModUpdateJournal,
	opts: { snapshot: boolean; label: string },
	task: TaskHandle
): Promise<void> {
	const root = instance.path;
	const mods = modsDir(root);
	const staging = path.join(root, journal.staging);
	const done: string[] = [];
	try {
		task.setProgress(null, 'Looking up versions');
		const resolved: { row: ModRow; version: ProjectVersion }[] = [];
		await eachLimited(changes, async (change) => {
			const row = rows.get(change.fileName)!;
			const version = await getModProvider(row.source).getVersion(row.slug!, change.versionId, {
				minecraftVersion: instance.minecraftVersion
			});
			resolved.push({ row, version });
		});

		if (opts.snapshot) await snapshotStep(instance, { reason: 'mod-update', label: `Before ${opts.label[0].toLowerCase()}${opts.label.slice(1)}` }, task);

		await fs.mkdir(staging, { recursive: true });
		let n = 0;
		for (const { row, version } of resolved) {
			task.setProgress(Math.round((n++ / resolved.length) * 100), `${row.name} ${version.versionNumber}`);
			// Staged first, so a new file with the same name cannot overwrite the only copy.
			await fs.rename(path.join(mods, row.fileName), path.join(staging, row.fileName));
			// A disabled jar's record may be under its enabled name.
			const recorded = [row.fileName, row.fileName.replace(/\.disabled$/, '')].map((n) => path.join('mods', n));
			db.delete(instanceMods)
				.where(and(eq(instanceMods.instanceId, instance.id), inArray(instanceMods.filePath, recorded)))
				.run();
			const installed = await installModVersion(
				instance,
				row.source as 'modrinth' | 'curseforge',
				{ id: row.slug!, slug: row.slug!, name: row.name, projectUrl: row.projectUrl, iconUrl: row.iconUrl },
				version,
				{ fromPack: row.fromPack }
			);
			if (row.locked) setModLocked(instance, path.join('mods', installed), true);
			if (!row.enabled) await setModEnabled(instance, installed, false);
			done.push(`${row.name} ${row.version ?? '?'} -> ${version.versionNumber}`);
		}
		commitOperation(instance.id, {});
	} catch (err) {
		task.log('The change failed; putting the mods back.');
		await restoreModUpdate(instance.id, root, journal);
		endOperation(instance.id);
		setStatus(instance.id, 'ready', `${opts.label} failed and the mods were put back: ${err instanceof Error ? err.message : 'unknown error'}`);
		throw err;
	}

	await fs.rm(staging, { recursive: true, force: true });
	for (const line of done) task.log(line);
	await syncUnit(requireInstance(instance.id)).catch(() => undefined);
	setStatus(instance.id, 'ready', null);
	audit('instance.mods_updated', { instanceId: instance.id, detail: done.join('; ').slice(0, 500) });
	task.setProgress(100, 'Ready');
}
