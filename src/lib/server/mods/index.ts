import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { instanceMods, mods as modsTable, type ServerInstance } from '../db/schema';
import { downloadFile, hashFile } from '../download';
import { modrinthProvider, projectsByIds, versionsFromHashes } from './modrinth';
import { ftbProvider } from './modpacksch';
import { curseforgeProvider } from './curseforge';
import type { ModProvider, ProjectVersion, SourceId } from './types';
import { safeJoin } from '../files';

export * from './types';
export { modrinthProvider, curseforgeProvider, ftbProvider };

export const PROVIDERS: Record<string, ModProvider> = {
	modrinth: modrinthProvider,
	curseforge: curseforgeProvider,
	ftb: ftbProvider
};

export function getProvider(id: string): ModProvider {
	const provider = PROVIDERS[id];
	if (!provider) throw new Error(`Unknown mod source "${id}".`);
	return provider;
}

const CHANNEL_PRIORITY: Record<string, number> = { release: 3, beta: 2, alpha: 1 };

/** Release before beta before alpha; newest first within a tier. */
export function compareVersionPriority(a: ProjectVersion, b: ProjectVersion): number {
	const tier = (CHANNEL_PRIORITY[b.channel] ?? 0) - (CHANNEL_PRIORITY[a.channel] ?? 0);
	if (tier !== 0) return tier;
	return (Date.parse(b.datePublished ?? '') || 0) - (Date.parse(a.datePublished ?? '') || 0);
}

/**
 * Picks the version to use when nothing pins an exact one: release beats
 * beta beats alpha, and the newest wins within a tier. Without this, "take
 * whatever the API returns first" can just as easily hand back a year-old
 * alpha as the current release.
 */
export function bestVersion(versions: ProjectVersion[]): ProjectVersion | null {
	if (versions.length === 0) return null;
	return [...versions].sort(compareVersionPriority)[0];
}

export const DISABLED_SUFFIX = '.disabled';

export function modsDir(instancePath: string): string {
	return path.join(instancePath, 'mods');
}

export type ModRow = {
	id: number | null;
	name: string;
	slug: string | null;
	source: SourceId;
	version: string | null;
	filePath: string;
	fileName: string;
	sizeBytes: number;
	enabled: boolean;
	fromPack: boolean;
	locked: boolean;
	projectUrl: string | null;
	iconUrl: string | null;
	/** True when the jar is on disk but MineShell has no record of installing it. */
	untracked: boolean;
	/** True when the DB row has no matching file. */
	missing: boolean;
};

/**
 * The mods folder is the source of truth for what will actually load; the DB is
 * the source of truth for where each jar came from. This reconciles the two and
 * surfaces the disagreements rather than hiding them.
 */
export async function listInstanceMods(instance: ServerInstance): Promise<ModRow[]> {
	const dir = modsDir(instance.path);
	await fs.mkdir(dir, { recursive: true });

	const files = (await fs.readdir(dir, { withFileTypes: true }))
		.filter((e) => e.isFile() && /\.jar(\.disabled)?$/i.test(e.name))
		.map((e) => e.name);

	const tracked = db
		.select({
			rowId: instanceMods.id,
			modId: modsTable.id,
			name: modsTable.name,
			slug: modsTable.slug,
			source: modsTable.source,
			projectUrl: modsTable.projectUrl,
			iconUrl: modsTable.iconUrl,
			version: instanceMods.version,
			filePath: instanceMods.filePath,
			enabled: instanceMods.enabled,
			fromPack: instanceMods.fromPack,
			locked: instanceMods.locked
		})
		.from(instanceMods)
		.innerJoin(modsTable, eq(instanceMods.modId, modsTable.id))
		.where(eq(instanceMods.instanceId, instance.id))
		.all();

	const byFile = new Map(tracked.map((row) => [path.basename(row.filePath), row]));
	const rows: ModRow[] = [];

	for (const fileName of files) {
		const enabled = !fileName.endsWith(DISABLED_SUFFIX);
		const baseName = enabled ? fileName : fileName.slice(0, -DISABLED_SUFFIX.length);
		const record = byFile.get(fileName) ?? byFile.get(baseName);
		let sizeBytes = 0;
		try {
			sizeBytes = (await fs.stat(path.join(dir, fileName))).size;
		} catch {
			/* ignore */
		}
		rows.push({
			id: record?.modId ?? null,
			name: record?.name ?? baseName.replace(/\.jar$/i, ''),
			slug: record?.slug ?? null,
			source: (record?.source as SourceId) ?? 'manual',
			version: record?.version ?? null,
			filePath: path.join('mods', fileName),
			fileName,
			sizeBytes,
			enabled,
			fromPack: record?.fromPack ?? false,
			locked: record?.locked ?? false,
			projectUrl: record?.projectUrl ?? null,
			iconUrl: record?.iconUrl ?? null,
			untracked: !record,
			missing: false
		});
		if (record) {
			byFile.delete(fileName);
			byFile.delete(baseName);
		}
	}

	// Anything left in the map has a DB row but no file.
	for (const [fileName, record] of byFile) {
		rows.push({
			id: record.modId,
			name: record.name,
			slug: record.slug,
			source: record.source as SourceId,
			version: record.version,
			filePath: record.filePath,
			fileName,
			sizeBytes: 0,
			enabled: false,
			fromPack: record.fromPack,
			locked: record.locked,
			projectUrl: record.projectUrl,
			iconUrl: record.iconUrl,
			untracked: false,
			missing: true
		});
	}

	return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export type SyncResult = {
	/** DB rows removed because their file no longer exists. */
	removedStale: number;
	/** Untracked files identified via Modrinth and given a real record. */
	resolved: number;
	/** Untracked files that couldn't be identified, tracked as plain manual jars instead. */
	trackedAsManual: number;
};

/**
 * Brings the DB in line with what's actually in the mods folder, in both
 * directions: drops rows whose jar is gone, and gives every untracked jar a
 * real record.
 *
 * Identification is hash-based against Modrinth, batched so a 150-mod pack
 * costs a couple of requests rather than 150. A CurseForge-only mod (or a
 * genuine network miss) can't be identified this way; those are tracked as a
 * plain manual entry, the same treatment as a hand-uploaded jar, so they stop
 * showing as untracked even though MineShell doesn't know their real name.
 *
 * Called automatically at the end of a pack install and available as a manual
 * action on the mods page.
 */
export async function syncMods(
	instance: ServerInstance,
	opts: { fromPack?: boolean; onProgress?: (done: number, total: number) => void } = {}
): Promise<SyncResult> {
	const rows = await listInstanceMods(instance);

	let removedStale = 0;
	for (const row of rows.filter((r) => r.missing)) {
		db.delete(instanceMods)
			.where(
				and(eq(instanceMods.instanceId, instance.id), eq(instanceMods.filePath, row.filePath))
			)
			.run();
		removedStale += 1;
	}

	const untracked = rows.filter((r) => r.untracked);
	if (untracked.length === 0) return { removedStale, resolved: 0, trackedAsManual: 0 };

	// Hash everything first, then identify in bulk.
	const hashed: { fileName: string; hash: string | null }[] = [];
	for (const [index, row] of untracked.entries()) {
		let hash: string | null = null;
		try {
			hash = await hashFile(safeJoin(modsDir(instance.path), row.fileName), 'sha512');
		} catch {
			/* unreadable or vanished mid-scan */
		}
		hashed.push({ fileName: row.fileName, hash });
		opts.onProgress?.(index + 1, untracked.length);
	}

	const byHash = await versionsFromHashes(
		hashed.map((h) => h.hash).filter((h): h is string => Boolean(h))
	);
	const projects = await projectsByIds(
		[...byHash.values()].map((v) => v.projectId).filter(Boolean)
	);

	let resolved = 0;
	let trackedAsManual = 0;

	for (const { fileName, hash } of hashed) {
		const version = hash ? byHash.get(hash) : undefined;
		const project = version ? projects.get(version.projectId) : undefined;

		if (version && project) {
			const modId = upsertMod({
				source: 'modrinth',
				slug: project.slug,
				name: project.name,
				author: project.author,
				summary: project.summary,
				projectUrl: project.projectUrl,
				iconUrl: project.iconUrl
			});
			recordInstanceMod({
				instanceId: instance.id,
				modId,
				version: version.versionNumber,
				versionId: version.id,
				filePath: path.join('mods', fileName),
				hash,
				hashAlgo: 'sha512',
				fromPack: opts.fromPack ?? true
			});
			resolved += 1;
		} else {
			await trackManualJar(instance, fileName, { fromPack: opts.fromPack ?? true, hash });
			trackedAsManual += 1;
		}
	}

	return { removedStale, resolved, trackedAsManual };
}

export async function setModEnabled(
	instance: ServerInstance,
	fileName: string,
	enabled: boolean
): Promise<void> {
	const dir = modsDir(instance.path);
	const current = safeJoin(dir, fileName);
	const base = fileName.endsWith(DISABLED_SUFFIX)
		? fileName.slice(0, -DISABLED_SUFFIX.length)
		: fileName;
	const target = safeJoin(dir, enabled ? base : `${base}${DISABLED_SUFFIX}`);
	if (current !== target) await fs.rename(current, target);

	db.update(instanceMods)
		.set({ enabled, filePath: path.join('mods', path.basename(target)) })
		.where(
			and(
				eq(instanceMods.instanceId, instance.id),
				eq(instanceMods.filePath, path.join('mods', path.basename(current)))
			)
		)
		.run();
}

export async function deleteMod(instance: ServerInstance, fileName: string): Promise<void> {
	const target = safeJoin(modsDir(instance.path), fileName);
	await fs.rm(target, { force: true });
	db.delete(instanceMods)
		.where(
			and(eq(instanceMods.instanceId, instance.id), eq(instanceMods.filePath, path.join('mods', fileName)))
		)
		.run();
}

export function setModLocked(instance: ServerInstance, filePath: string, locked: boolean): void {
	db.update(instanceMods)
		.set({ locked })
		.where(and(eq(instanceMods.instanceId, instance.id), eq(instanceMods.filePath, filePath)))
		.run();
}

export function upsertMod(input: {
	source: SourceId;
	slug: string;
	name: string;
	author?: string | null;
	summary?: string | null;
	projectUrl?: string | null;
	iconUrl?: string | null;
}): number {
	const existing = db
		.select()
		.from(modsTable)
		.where(and(eq(modsTable.source, input.source), eq(modsTable.slug, input.slug)))
		.get();
	if (existing) return existing.id;
	const inserted = db
		.insert(modsTable)
		.values({
			source: input.source,
			slug: input.slug,
			name: input.name,
			author: input.author ?? null,
			summary: input.summary ?? null,
			projectUrl: input.projectUrl ?? null,
			iconUrl: input.iconUrl ?? null
		})
		.returning({ id: modsTable.id })
		.get();
	return inserted.id;
}

export function recordInstanceMod(input: {
	instanceId: string;
	modId: number;
	version: string | null;
	versionId: string | null;
	filePath: string;
	hash: string | null;
	hashAlgo: string | null;
	fromPack: boolean;
}): void {
	db.insert(instanceMods)
		.values({ ...input, enabled: true, locked: false, installedAt: Date.now() })
		.onConflictDoUpdate({
			target: [instanceMods.instanceId, instanceMods.filePath],
			set: {
				modId: input.modId,
				version: input.version,
				versionId: input.versionId,
				hash: input.hash,
				hashAlgo: input.hashAlgo,
				installedAt: Date.now()
			}
		})
		.run();
}

/** Download one version's primary file into the instance and record it. */
export async function installModVersion(
	instance: ServerInstance,
	source: SourceId,
	project: { id: string; slug: string; name: string; projectUrl: string | null; iconUrl: string | null },
	version: ProjectVersion,
	opts: { fromPack?: boolean; onProgress?: (received: number, total: number | null) => void } = {}
): Promise<string> {
	const file = version.files.find((f) => f.primary) ?? version.files[0];
	if (!file) throw new Error(`${project.name} ${version.versionNumber} has no downloadable file.`);

	const dir = modsDir(instance.path);
	const destination = path.join(dir, file.filename);
	await downloadFile(file.url, destination, { hash: file.hash, onProgress: opts.onProgress });

	const modId = upsertMod({
		source,
		slug: project.slug || project.id,
		name: project.name,
		projectUrl: project.projectUrl,
		iconUrl: project.iconUrl
	});
	recordInstanceMod({
		instanceId: instance.id,
		modId,
		version: version.versionNumber,
		versionId: version.id,
		filePath: path.join('mods', file.filename),
		hash: file.hash?.value ?? (await hashFile(destination)),
		hashAlgo: file.hash?.algo ?? 'sha512',
		fromPack: opts.fromPack ?? false
	});
	return file.filename;
}

/** Register a hand-uploaded jar (or an unidentifiable pack jar) so it stops showing as untracked. */
export async function trackManualJar(
	instance: ServerInstance,
	fileName: string,
	opts: { fromPack?: boolean; hash?: string | null } = {}
): Promise<void> {
	const modId = upsertMod({ source: 'manual', slug: fileName, name: fileName.replace(/\.jar$/i, '') });
	recordInstanceMod({
		instanceId: instance.id,
		modId,
		version: null,
		versionId: null,
		filePath: path.join('mods', fileName),
		hash: opts.hash ?? null,
		hashAlgo: opts.hash ? 'sha512' : null,
		fromPack: opts.fromPack ?? false
	});
}
