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
	DISABLED_SUFFIX,
	getModProvider,
	installModVersion,
	listInstanceMods,
	modsDir,
	setModEnabled,
	setModLocked,
	syncMods,
	type ModRow,
	type ProjectVersion
} from './mods';
import { latestVersionsFromHashes } from './mods/modrinth';
import { curseforgeOrigins } from './packs';
import { resolveProviderPack } from './packs/resolve';
import { hashFile } from './download';
import { getLoader, LOADER_FALLBACKS, type ModloaderId } from './modloaders';
import { beginOperation, commitOperation, endOperation, OperationInProgressError, type Journal } from './operations';
import { startTask, type TaskHandle } from './tasks';
import { snapshotStep } from './snapshots';
import { indexMods } from './crashdiag';

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

/**
 * Track jars MineShell did not install (and fix pack mods tracked wrongly),
 * as the Mods page's Sync does. A CurseForge pack's file list says which
 * project each of its jars is - one request; without it, hashes alone.
 * Returns a summary line, or null when nothing changed.
 */
export async function syncInstanceMods(instance: ServerInstance): Promise<string | null> {
	let origins: Map<string, { projectId: string; fileId: string }> | undefined;
	if (instance.packSource === 'curseforge' && instance.packProjectId && instance.packVersionId) {
		origins = await resolveProviderPack('curseforge', instance.packProjectId, instance.packVersionId)
			.then(({ pack }) => curseforgeOrigins(pack))
			.catch(() => undefined);
	}
	const { removedStale, resolved, curseforge, trackedAsManual } = await syncMods(instance, { fromPack: false, curseforge: origins });
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
	const parts: string[] = [];
	if (curseforge) parts.push(`tracked ${plural(curseforge, 'mod')} as CurseForge`);
	if (resolved) parts.push(`identified ${plural(resolved, 'mod')}`);
	if (trackedAsManual) parts.push(`tracked ${plural(trackedAsManual, 'unrecognised file')} as manual`);
	if (removedStale) parts.push(`cleared ${plural(removedStale, 'stale record')}`);
	return parts.length ? parts.join(', ') : null;
}

export type Filter = { minecraftVersion: string; loaders: string[] };

/** What a mod build must support to run on `instance` (or on what a migration moves it to). */
export function filterFor(instance: Pick<ServerInstance, 'modloader' | 'minecraftVersion'>): Filter {
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

/**
 * A changelog's first line of substance, as plain text, for one line in the
 * update list: headings that only repeat the name or version are skipped,
 * list markers and markdown links and emphasis dropped.
 */
export function changelogNote(changelog: string | null | undefined): string | null {
	for (const raw of (changelog ?? '').split('\n')) {
		if (/^\s*#/.test(raw)) continue;
		const line = raw
			.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
			.replace(/<[^>]+>/g, '')
			.replace(/[*_`]/g, '')
			.trim();
		if (line.length > 2) return line.length > 120 ? `${line.slice(0, 117)}...` : line;
	}
	return null;
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
	/** The first line of the new version's changelog, where the source has one. */
	note: string | null;
};

export type UpdateCheck = {
	updates: ModUpdate[];
	upToDate: number;
	skipped: { fileName: string; name: string; reason: string }[];
	/** What updating all of them brings in; worked out again for what is actually applied. */
	dependencies: DependencyPlan;
	/** What the sync run first did, when there were untracked jars. */
	synced: string | null;
};

const LOOKUP_CONCURRENCY = 6;

export async function eachLimited<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
	const queue = [...items];
	await Promise.all(
		Array.from({ length: Math.min(LOOKUP_CONCURRENCY, queue.length) }, async () => {
			for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item);
		})
	);
}

export function trackable(row: ModRow): boolean {
	return (row.source === 'modrinth' || row.source === 'curseforge') && !!row.slug && !row.missing;
}

/**
 * Which mods have a newer compatible version. Jars MineShell has no record
 * of are synced first (identified as Modrinth/CurseForge where possible),
 * so a folder filled by hand can be updated too.
 */
export async function checkModUpdates(instance: ServerInstance): Promise<UpdateCheck> {
	const filter = filterFor(instance);
	let synced: string | null = null;
	if ((await listInstanceMods(instance)).some((r) => r.untracked || r.missing)) synced = await syncInstanceMods(instance);
	const rows = (await listInstanceMods(instance)).filter((r) => !r.missing);
	const result: UpdateCheck = {
		updates: [],
		upToDate: 0,
		skipped: [],
		dependencies: { install: [], unresolved: [], conflicts: [], unneeded: [] },
		synced: null
	};
	const targets: Target[] = [];
	const changes: { row: ModRow; version: ProjectVersion }[] = [];
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
			const versions = await compatibleVersions(row.source, row.slug!, filter);
			const target = pickUpdate(versions, row);
			if (!target) {
				result.upToDate++;
				return;
			}
			targets.push({ source: row.source, name: row.name, slug: row.slug!, version: target });
			// Disabled ones are not updated unless ticked (the review starts them unticked).
			if (row.enabled) changes.push({ row, version: target });
			result.updates.push({
				fileName: row.fileName,
				name: row.name,
				source: row.source,
				currentVersion: row.version,
				targetVersionId: target.id,
				targetVersion: target.versionNumber,
				channel: target.channel,
				enabled: row.enabled,
				fromPack: row.fromPack,
				note: changelogNote(target.changelog)
			});
		} catch (err) {
			result.skipped.push({ fileName: row.fileName, name: row.name, reason: `Lookup failed: ${err instanceof Error ? err.message : 'unknown error'}` });
		}
	});
	result.updates.sort((a, b) => a.name.localeCompare(b.name));
	result.skipped.sort((a, b) => a.name.localeCompare(b.name));
	const deps = await resolveDependencies(instance, targets);
	result.dependencies = {
		...deps.plan,
		unneeded: await unneededDependencies(instance, changes, [...changes.map((c) => c.version), ...deps.resolved.map((d) => d.version)])
	};
	result.synced = synced;
	return result;
}

/** Every version of a project that runs on this server, newest first, across the loaders it accepts. */
export async function compatibleVersions(source: string, projectId: string, filter: Filter): Promise<ProjectVersion[]> {
	const provider = getModProvider(source);
	const seen = new Map<string, ProjectVersion>();
	for (const loader of filter.loaders) {
		for (const v of await provider.listVersions(projectId, { minecraftVersion: filter.minecraftVersion, loader })) {
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
	const versions = await compatibleVersions(row.source, row.slug!, filterFor(instance));
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

// --------------------------------------------------------- dependencies ---

export type Target = { source: string; name: string; slug: string; version: ProjectVersion };

export type DependencyPlan = {
	/** Required dependencies that are not installed, and the version that would be. */
	install: { source: string; projectId: string; name: string; versionId: string; versionNumber: string; neededBy: string[] }[];
	/** Required dependencies with no version for this server, or that could not be looked up. */
	unresolved: { name: string; neededBy: string[]; reason: string }[];
	/** Enabled mods a new version (or a dependency it brings) declares incompatible. Modrinth only: the mirror has no such type. */
	conflicts: { name: string; fileName: string; declaredBy: string[] }[];
	/** Installed dependencies only the old versions required: offered to be disabled (unneededDependencies). */
	unneeded: Unneeded[];
};

export type Unneeded = { fileName: string; name: string; neededBy: string[] };

export type ResolvedDependency = {
	source: string;
	project: { id: string; slug: string; name: string; projectUrl: string | null; iconUrl: string | null };
	version: ProjectVersion;
	neededBy: string[];
};

/** Dependencies of dependencies are followed this far. */
const DEPENDENCY_DEPTH = 4;

/**
 * The required dependencies the target versions bring in that are not on
 * the server yet, followed through their own dependencies. A dependency
 * counts as present when an installed mod is the same project (its slug or
 * id) or has the same name, so one installed from the other platform is not
 * installed twice; mods that are themselves being changed count as present.
 */
export async function resolveDependencies(
	instance: ServerInstance,
	targets: Target[],
	/** A migration resolves for its target, and mods it disables do not count as present. */
	opts: { filter?: Filter; ignore?: Set<string> } = {}
): Promise<{ plan: DependencyPlan; resolved: ResolvedDependency[] }> {
	const filter = opts.filter ?? filterFor(instance);
	const installed = new Set<string>();
	const rows = (await listInstanceMods(instance)).filter((r) => !r.missing && !opts.ignore?.has(r.fileName));
	for (const row of rows) {
		installed.add(row.name.toLowerCase());
		if (row.slug) installed.add(`${row.source}:${row.slug.toLowerCase()}`);
	}
	for (const t of targets) installed.add(`${t.source}:${t.slug.toLowerCase()}`);
	const present = (source: string, hit: { id: string; slug: string; name: string }) =>
		installed.has(`${source}:${hit.slug.toLowerCase()}`) ||
		installed.has(`${source}:${hit.id.toLowerCase()}`) ||
		installed.has(hit.name.toLowerCase());

	const resolved = new Map<string, ResolvedDependency>();
	const unresolved = new Map<string, DependencyPlan['unresolved'][number]>();
	type Pending = { source: string; projectId: string | null; versionId: string | null; name: string | null; neededBy: string; depth: number };
	const queue: Pending[] = targets.flatMap((t) =>
		t.version.dependencies
			.filter((d) => d.type === 'required' && (d.projectId || d.versionId))
			.map((d) => ({ source: t.source, projectId: d.projectId, versionId: d.versionId, name: d.name, neededBy: t.name, depth: 1 }))
	);

	for (let next = queue.shift(); next; next = queue.shift()) {
		const provider = getModProvider(next.source);
		try {
			// Modrinth can name a dependency by version only.
			const pinned = next.versionId
				? await provider.getVersion(next.projectId ?? '', next.versionId, { minecraftVersion: filter.minecraftVersion })
				: null;
			const projectId = next.projectId ?? pinned?.projectId;
			if (!projectId) continue;
			const key = `${next.source}:${projectId}`;
			const already = resolved.get(key) ?? unresolved.get(key);
			if (already) {
				if (!already.neededBy.includes(next.neededBy)) already.neededBy.push(next.neededBy);
				continue;
			}
			const hit = await provider.getProject(projectId);
			if (present(next.source, hit)) continue;
			const version = pinned ?? bestVersion(await compatibleVersions(next.source, projectId, filter));
			if (!version) {
				unresolved.set(key, { name: hit.name, neededBy: [next.neededBy], reason: `No version for ${filter.loaders[0]} ${filter.minecraftVersion}` });
				continue;
			}
			resolved.set(key, {
				source: next.source,
				project: { id: hit.id, slug: hit.slug || hit.id, name: hit.name, projectUrl: hit.projectUrl, iconUrl: hit.iconUrl },
				version,
				neededBy: [next.neededBy]
			});
			installed.add(`${next.source}:${(hit.slug || hit.id).toLowerCase()}`);
			if (next.depth < DEPENDENCY_DEPTH) {
				for (const d of version.dependencies.filter((d) => d.type === 'required' && (d.projectId || d.versionId))) {
					queue.push({ source: next.source, projectId: d.projectId, versionId: d.versionId, name: d.name, neededBy: hit.name, depth: next.depth + 1 });
				}
			}
		} catch (err) {
			const key = `${next.source}:${next.projectId ?? next.versionId}`;
			if (!unresolved.has(key)) {
				unresolved.set(key, {
					name: next.name ?? next.projectId ?? 'A dependency',
					neededBy: [next.neededBy],
					reason: `Lookup failed: ${err instanceof Error ? err.message : 'unknown error'}`
				});
			}
		}
	}

	const list = [...resolved.values()];
	const conflicts = await findConflicts(rows, [...targets, ...list.map((d) => ({ source: d.source, name: d.project.name, version: d.version }))]);
	return {
		resolved: list,
		plan: {
			conflicts,
			unneeded: [],
			install: list
				.map((d) => ({
					source: d.source,
					projectId: d.project.id,
					name: d.project.name,
					versionId: d.version.id,
					versionNumber: d.version.versionNumber,
					neededBy: d.neededBy
				}))
				.sort((a, b) => a.name.localeCompare(b.name)),
			unresolved: [...unresolved.values()].sort((a, b) => a.name.localeCompare(b.name))
		}
	};
}

/**
 * Enabled mods that an incoming version declares `incompatible` (Modrinth's
 * dependency type; the mirror only knows required and optional). Matched by
 * source and slug or id, or by name; a lookup that fails says nothing.
 */
async function findConflicts(
	rows: ModRow[],
	incoming: { source: string; name: string; version: ProjectVersion }[]
): Promise<DependencyPlan['conflicts']> {
	const found = new Map<string, DependencyPlan['conflicts'][number]>();
	const enabled = rows.filter((r) => r.enabled);
	for (const item of incoming) {
		for (const d of item.version.dependencies) {
			if (d.type !== 'incompatible' || !d.projectId) continue;
			const hit = await getModProvider(item.source)
				.getProject(d.projectId)
				.catch(() => null);
			const ids = new Set([d.projectId, hit?.id, hit?.slug].filter(Boolean).map((v) => v!.toLowerCase()));
			const row = enabled.find(
				(r) =>
					(r.source === item.source && r.slug && ids.has(r.slug.toLowerCase())) ||
					(hit && r.name.toLowerCase() === hit.name.toLowerCase())
			);
			if (!row) continue;
			const entry = found.get(row.fileName) ?? { name: row.name, fileName: row.fileName, declaredBy: [] };
			if (!entry.declaredBy.includes(item.name)) entry.declaredBy.push(item.name);
			found.set(row.fileName, entry);
		}
	}
	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Project ids as the platform gives them: Modrinth's are case-sensitive. */
const requiredIds = (v: ProjectVersion) => v.dependencies.filter((d) => d.type === 'required' && d.projectId).map((d) => d.projectId!);

/**
 * Installed mods that only the old versions of the mods being changed
 * required: the old version's required dependencies (platform metadata) that
 * the new one, and nothing else incoming, still requires - and that no other
 * enabled jar requires (its own metadata, crashdiag's index). A jar whose ids
 * cannot be read, a locked one and a pack's own are never offered.
 */
export async function unneededDependencies(
	instance: ServerInstance,
	changes: { row: ModRow; version: ProjectVersion }[],
	incoming: ProjectVersion[]
): Promise<Unneeded[]> {
	const stillRequired = new Set(incoming.flatMap(requiredIds));
	const dropped = new Map<string, { source: string; projectId: string; neededBy: string[] }>();
	await eachLimited(changes, async ({ row, version }) => {
		if (!row.versionId || row.versionId === version.id) return;
		const old = await getModProvider(row.source)
			.getVersion(row.slug!, row.versionId, { minecraftVersion: instance.minecraftVersion })
			.catch(() => null);
		const now = new Set(requiredIds(version));
		for (const id of old ? requiredIds(old) : []) {
			if (now.has(id) || stillRequired.has(id)) continue;
			const entry = dropped.get(`${row.source}:${id}`) ?? { source: row.source, projectId: id, neededBy: [] };
			entry.neededBy.push(row.name);
			dropped.set(`${row.source}:${id}`, entry);
		}
	});
	if (!dropped.size) return [];

	const rows = (await listInstanceMods(instance)).filter((r) => !r.missing);
	const changing = new Set(changes.map((c) => c.row.fileName));
	const jars = await indexMods(modsDir(instance.path));
	const jarByFile = new Map(jars.map((j) => [j.fileName, j]));
	const out: Unneeded[] = [];
	for (const { source, projectId, neededBy } of dropped.values()) {
		const project = await getModProvider(source)
			.getProject(projectId)
			.catch(() => null);
		const keys = new Set([projectId, project?.id, project?.slug].filter(Boolean).map((v) => v!.toLowerCase()));
		const row = rows.find((r) => r.source === source && r.slug && keys.has(r.slug.toLowerCase()));
		if (!row || !row.enabled || row.locked || row.fromPack || changing.has(row.fileName)) continue;
		const ids = jarByFile.get(row.fileName)?.ids ?? [];
		if (!ids.length) continue;
		const users = jars.filter(
			(j) => j.enabled && j.fileName !== row.fileName && !changing.has(j.fileName) && j.requires.some((id) => ids.includes(id))
		);
		if (!users.length) out.push({ fileName: row.fileName, name: row.name, neededBy });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Turns a mod off inside a journalled change: the original goes to the
 * staging folder and a copy comes back as .disabled, because the restore
 * deletes every mods/ file that was not there before - a plain rename would
 * lose the jar on rollback.
 */
export async function disableStaged(instance: ServerInstance, staging: string, fileName: string): Promise<void> {
	const mods = modsDir(instance.path);
	await fs.mkdir(staging, { recursive: true });
	await fs.rename(path.join(mods, fileName), path.join(staging, fileName));
	await fs.copyFile(path.join(staging, fileName), path.join(mods, `${fileName}${DISABLED_SUFFIX}`));
	db.update(instanceMods)
		.set({ enabled: false, filePath: path.join('mods', `${fileName}${DISABLED_SUFFIX}`) })
		.where(and(eq(instanceMods.instanceId, instance.id), eq(instanceMods.filePath, path.join('mods', fileName))))
		.run();
}

/** What switching one mod to `versionId` would bring in, for the version picker. */
export async function previewDependencies(instance: ServerInstance, fileName: string, versionId: string): Promise<DependencyPlan> {
	const row = (await listInstanceMods(instance)).find((r) => r.fileName === fileName);
	if (!row || !trackable(row)) throw new InstanceError('Only mods from Modrinth or CurseForge can change version here.');
	const version = await getModProvider(row.source).getVersion(row.slug!, versionId, { minecraftVersion: instance.minecraftVersion });
	const { plan, resolved } = await resolveDependencies(instance, [{ source: row.source, name: row.name, slug: row.slug!, version }]);
	return { ...plan, unneeded: await unneededDependencies(instance, [{ row, version }], [version, ...resolved.map((d) => d.version)]) };
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
	opts: { snapshot: boolean; label: string; disableUnneeded?: string[] }
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
	opts: { snapshot: boolean; label: string; disableUnneeded?: string[] },
	task: TaskHandle
): Promise<void> {
	const root = instance.path;
	const mods = modsDir(root);
	const staging = path.join(root, journal.staging);
	const done: string[] = [];
	const problems: string[] = [];
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
		task.setProgress(null, 'Resolving dependencies');
		const deps = await resolveDependencies(
			instance,
			resolved.map(({ row, version }) => ({ source: row.source, name: row.name, slug: row.slug!, version }))
		);
		for (const u of deps.plan.unresolved) {
			problems.push(`${u.name} (needed by ${u.neededBy.join(', ')}) could not be installed: ${u.reason}.`);
		}
		for (const c of deps.plan.conflicts) {
			problems.push(`${c.declaredBy.join(', ')} declare${c.declaredBy.length === 1 ? 's' : ''} ${c.name} incompatible.`);
		}
		// Worked out again for what is applied: only offered ones the person kept ticked.
		const chosen = new Set(opts.disableUnneeded ?? []);
		const unneeded = chosen.size
			? (await unneededDependencies(instance, resolved, [...resolved.map((r) => r.version), ...deps.resolved.map((d) => d.version)])).filter((u) =>
					chosen.has(u.fileName)
				)
			: [];

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
		for (const dep of deps.resolved) {
			task.setProgress(null, `Installing ${dep.project.name}`);
			await installModVersion(instance, dep.source as 'modrinth' | 'curseforge', dep.project, dep.version);
			done.push(`Installed ${dep.project.name} ${dep.version.versionNumber}, needed by ${dep.neededBy.join(', ')}`);
		}
		for (const u of unneeded) {
			await disableStaged(instance, staging, u.fileName);
			done.push(`Disabled ${u.name}: only the old version of ${u.neededBy.join(', ')} needed it`);
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
	for (const line of problems) task.log(line);
	await syncUnit(requireInstance(instance.id)).catch(() => undefined);
	setStatus(instance.id, 'ready', problems.length ? problems.join(' ') : null);
	audit('instance.mods_updated', { instanceId: instance.id, detail: done.join('; ').slice(0, 500) });
	task.setProgress(100, 'Ready');
}
