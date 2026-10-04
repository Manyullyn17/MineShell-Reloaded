import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { instanceDatapacks, type ServerInstance } from '../db/schema';
import { downloadFile, hashFile } from '../download';
import { serverWorldName } from '../packworld';
import { zipEntryNames } from '../zip';
import { child, parseNbt } from '../nbt';
import type { ProjectVersion, SourceId } from './types';

/**
 * Data packs from the mod browser. Modrinth lists a data pack release under
 * the loader "datapack"; such a version (one that does not also run on the
 * server's loader) goes into <level-name>/datapacks/ instead of mods/.
 * Minecraft loads a new pack found there when the world loads; with no world
 * yet, it is there when the world is created, which world-generation packs
 * need.
 */

/** Loaders whose mods also run on this one (Quilt runs Fabric mods). */
const ALSO_RUNS: Record<string, string[]> = { quilt: ['fabric'], neoforge: [] };

export function isDatapackVersion(version: Pick<ProjectVersion, 'loaders'>, loader: string): boolean {
	if (!version.loaders.includes('datapack')) return false;
	if (loader === 'vanilla') return true;
	return ![loader, ...(ALSO_RUNS[loader] ?? [])].some((l) => version.loaders.includes(l));
}

export async function datapacksDir(root: string): Promise<{ world: string; dir: string }> {
	const world = await serverWorldName(root);
	return { world, dir: path.join(root, world, 'datapacks') };
}

/** A data pack's file name as it may sit in the folder: no path, no tricks. */
function safeFileName(name: string): string {
	const base = path.basename(name);
	if (!base || base.startsWith('.') || base !== name) throw new Error(`"${name}" is not a usable file name.`);
	return base;
}

export async function installDatapackVersion(
	instance: ServerInstance,
	source: SourceId,
	project: { id: string; slug: string; name: string; projectUrl: string | null; iconUrl: string | null },
	version: ProjectVersion
): Promise<string> {
	const file = version.files.find((f) => f.primary) ?? version.files[0];
	if (!file) throw new Error(`${project.name} ${version.versionNumber} has no downloadable file.`);
	const fileName = safeFileName(file.filename);
	const { dir } = await datapacksDir(instance.path);
	await fs.mkdir(dir, { recursive: true });
	const destination = path.join(dir, fileName);
	await downloadFile(file.url, destination, { hash: file.hash });

	// One file per project: a newer version replaces the older one's file and row.
	const previous = db
		.select()
		.from(instanceDatapacks)
		.where(and(eq(instanceDatapacks.instanceId, instance.id), eq(instanceDatapacks.projectId, project.id)))
		.all();
	for (const row of previous.filter((r) => r.fileName !== fileName)) {
		await fs.rm(path.join(dir, row.fileName), { recursive: true, force: true });
		db.delete(instanceDatapacks).where(eq(instanceDatapacks.id, row.id)).run();
	}

	const values = {
		instanceId: instance.id,
		source,
		projectId: project.id,
		slug: project.slug || project.id,
		name: project.name,
		projectUrl: project.projectUrl,
		iconUrl: project.iconUrl,
		version: version.versionNumber,
		versionId: version.id,
		fileName,
		hash: file.hash?.value ?? (await hashFile(destination)),
		installedAt: Date.now()
	};
	db.insert(instanceDatapacks)
		.values(values)
		.onConflictDoUpdate({ target: [instanceDatapacks.instanceId, instanceDatapacks.fileName], set: values })
		.run();
	return fileName;
}

/**
 * A pack that adds or changes world generation. level.dat stores the world's
 * generation settings, which then name the pack's biomes and noise settings:
 * once the world has loaded it, removing the pack stops the world from
 * loading ("Failed to decode value ... terralith:moonlight_valley"), seen with
 * Terralith on 1.20.1.
 */
const WORLDGEN = /^data\/[^/]+\/(worldgen|dimension|dimension_type)\//;

async function changesWorldgen(full: string, isDirectory: boolean): Promise<boolean> {
	if (!isDirectory) return ((await zipEntryNames(full)) ?? []).some((name) => WORLDGEN.test(name));
	const data = path.join(full, 'data');
	for (const ns of await fs.readdir(data, { withFileTypes: true }).catch(() => [])) {
		if (!ns.isDirectory()) continue;
		const sub = await fs.readdir(path.join(data, ns.name)).catch(() => [] as string[]);
		if (sub.some((name) => ['worldgen', 'dimension', 'dimension_type'].includes(name))) return true;
	}
	return false;
}

/** The world's enabled packs as level.dat records them: "file/Terralith_1.20_v2.5.4.zip", "vanilla", ... */
async function enabledInWorld(root: string, world: string): Promise<Set<string>> {
	try {
		const level = parseNbt(await fs.readFile(path.join(root, world, 'level.dat')));
		const enabled = child(child(child(level.root, 'Data'), 'DataPacks'), 'Enabled');
		if (enabled?.type !== 'list') return new Set();
		return new Set(enabled.value.flatMap((tag) => (tag.type === 'string' ? [tag.value] : [])));
	} catch {
		return new Set();
	}
}

export class DatapackInUseError extends Error {}

export type DatapackRow = {
	fileName: string;
	/** Relative to the server folder, for Files. */
	path: string;
	name: string;
	version: string | null;
	projectUrl: string | null;
	sizeBytes: number;
	/** Put there by the modpack (server_instances.pack_datapacks); a pack change replaces it. */
	fromPack: boolean;
	/** Installed from the browser. */
	tracked: boolean;
	/** Adds or changes world generation (see WORLDGEN). */
	worldgen: boolean;
	/** level.dat lists it as enabled: the world has loaded it. */
	loadedByWorld: boolean;
};

/** What is in the world's datapacks folder, with where each came from. */
export async function listDatapacks(instance: ServerInstance): Promise<{ world: string; packs: DatapackRow[] }> {
	const { world, dir } = await datapacksDir(instance.path);
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const rows = db.select().from(instanceDatapacks).where(eq(instanceDatapacks.instanceId, instance.id)).all();
	const byFile = new Map(rows.map((r) => [r.fileName, r]));
	let fromPack = new Set<string>();
	try {
		fromPack = new Set(JSON.parse(instance.packDatapacks ?? '[]') as string[]);
	} catch {
		/* unknown: nothing marked */
	}
	const enabled = await enabledInWorld(instance.path, world);
	const packs: DatapackRow[] = [];
	for (const entry of entries) {
		// Minecraft loads folders and .zip files from here; anything else is ignored by it too.
		if (!entry.isDirectory() && !/\.zip$/i.test(entry.name)) continue;
		const row = byFile.get(entry.name);
		const stat = await fs.stat(path.join(dir, entry.name)).catch(() => null);
		packs.push({
			fileName: entry.name,
			path: path.join(world, 'datapacks', entry.name),
			name: row?.name ?? entry.name.replace(/\.zip$/i, ''),
			version: row?.version ?? null,
			projectUrl: row?.projectUrl ?? null,
			sizeBytes: stat?.isFile() ? stat.size : 0,
			fromPack: fromPack.has(entry.name),
			tracked: !!row,
			worldgen: await changesWorldgen(path.join(dir, entry.name), entry.isDirectory()),
			loadedByWorld: enabled.has(`file/${entry.name}`)
		});
	}
	return { world, packs: packs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) };
}

/**
 * Deletes a data pack from the folder; the world drops it at the next start or
 * /reload. A world-generation pack the world has loaded is refused unless
 * `force`: the world may not load without it.
 */
export async function removeDatapack(instance: ServerInstance, fileName: string, opts: { force?: boolean } = {}): Promise<void> {
	const name = safeFileName(fileName);
	const { world, dir } = await datapacksDir(instance.path);
	const full = path.join(dir, name);
	if (!opts.force) {
		const stat = await fs.stat(full).catch(() => null);
		if (stat && (await enabledInWorld(instance.path, world)).has(`file/${name}`) && (await changesWorldgen(full, stat.isDirectory()))) {
			throw new DatapackInUseError(
				`${name} changes world generation and this world has loaded it. Without it Minecraft may not load the world at all. Take a snapshot first if you go ahead.`
			);
		}
	}
	await fs.rm(full, { recursive: true, force: true });
	db.delete(instanceDatapacks)
		.where(and(eq(instanceDatapacks.instanceId, instance.id), eq(instanceDatapacks.fileName, name)))
		.run();
}

/** A copied server's files include the data packs; its rows say where they came from. */
export function copyDatapackRows(fromId: string, toId: string): void {
	for (const { id: _id, ...row } of db.select().from(instanceDatapacks).where(eq(instanceDatapacks.instanceId, fromId)).all()) {
		db.insert(instanceDatapacks).values({ ...row, instanceId: toId }).run();
	}
}
