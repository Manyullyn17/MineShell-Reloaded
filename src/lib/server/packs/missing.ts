import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { serverInstances, type ServerInstance } from '../db/schema';
import type { ModloaderId } from '../modloaders';
import { curseforgeModProvider as mirrorMods } from '../mods/modpacksch';
import { syncMods } from '../mods';
import { startTask, type TaskHandle } from '../tasks';
import { curseforgeOrigins, downloadPackFiles, type FailedDownload, type PackDownload, type ParsedPack } from './index';

/**
 * Pack files an install or pack change could not download, kept with the
 * server so the overview can list them with where to get each one by hand,
 * and try them again. Each install or pack change replaces the list; a file
 * that has since appeared at its place drops off it.
 */
export type MissingDownload = {
	/** The file's name, or "CurseForge file <id>" when a manifest.json entry never resolved. */
	name: string;
	download: PackDownload;
	/** A page to download it from by hand. */
	page: string | null;
	error: string;
};

const FILE = path.join('.mineshell', 'missing-downloads.json');
/** Page lookups per list: a network that is down fails every file at once. */
const PAGE_LOOKUPS = 30;

export function missingNotice(count: number): string {
	return `${count} pack file${count === 1 ? '' : 's'} could not be downloaded; the overview lists ${count === 1 ? 'it' : 'them'} with download links.`;
}

/** The status message without the notice, once nothing is missing any more. */
export function withoutMissingNotice(message: string | null): string | null {
	return message?.replace(/\d+ pack files? could not be downloaded; the overview lists (it|them) with download links\./, '').replace(/\s+/g, ' ').trim() || null;
}

/** Where a CurseForge file can be downloaded by hand: its file page, from the mirror's project link. */
async function downloadPage(curseforge: PackDownload['curseforge'], lookup: boolean): Promise<string | null> {
	if (!curseforge) return null;
	const project = lookup ? await mirrorMods.getProject(String(curseforge.projectId)).catch(() => null) : null;
	return project?.projectUrl
		? `${project.projectUrl.replace(/\/+$/, '')}/files/${curseforge.fileId}`
		: `https://www.curseforge.com/projects/${curseforge.projectId}`;
}

export async function recordMissing(root: string, failures: FailedDownload[]): Promise<void> {
	const file = path.join(root, FILE);
	if (!failures.length) {
		await fs.rm(file, { force: true });
		return;
	}
	const list: MissingDownload[] = await Promise.all(
		failures.map(async (f, i) => ({
			name: f.download.target ? path.posix.basename(f.download.target) : f.file,
			download: f.download,
			page: await downloadPage(f.download.curseforge, i < PAGE_LOOKUPS),
			error: f.error
		}))
	);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(list, null, '\t'));
}

/** The files still missing: ones that are in place now (added by hand, or a retry) are left out. */
export async function readMissing(root: string): Promise<MissingDownload[]> {
	let list: MissingDownload[];
	try {
		list = JSON.parse(await fs.readFile(path.join(root, FILE), 'utf8'));
		if (!Array.isArray(list)) return [];
	} catch {
		return [];
	}
	const present = await Promise.all(
		list.map((m) =>
			m.download.target
				? fs.access(path.join(root, m.download.target)).then(
						() => true,
						() => false
					)
				: false
		)
	);
	return list.filter((_, i) => !present[i]);
}

export async function forgetMissing(root: string): Promise<void> {
	await fs.rm(path.join(root, FILE), { force: true });
}

const retrying = new Set<string>();

/** retryMissing as a task, at most one per server; null when one is already running. */
export function startRetryMissing(instance: ServerInstance): string | null {
	if (retrying.has(instance.id)) return null;
	retrying.add(instance.id);
	return startTask({ label: `Downloading missing pack files for ${instance.name}`, instanceId: instance.id }, async (task) => {
		try {
			if ((await retryMissing(instance, task)) === 0) {
				const current = db.select().from(serverInstances).where(eq(serverInstances.id, instance.id)).get();
				if (current) {
					db.update(serverInstances)
						.set({ statusMessage: withoutMissingNotice(current.statusMessage) })
						.where(eq(serverInstances.id, instance.id))
						.run();
				}
			}
		} finally {
			retrying.delete(instance.id);
		}
	});
}

/**
 * Downloads the listed files again and tracks the ones that arrive like the
 * pack's other mods (fromPack, so a later pack change still replaces them).
 * Returns how many are still missing.
 */
export async function retryMissing(instance: ServerInstance, task: TaskHandle): Promise<number> {
	const missing = await readMissing(instance.path);
	const pack: ParsedPack = {
		kind: 'curseforge',
		name: instance.name,
		version: null,
		minecraftVersion: instance.minecraftVersion,
		modloader: instance.modloader as ModloaderId,
		modloaderVersion: instance.modloaderVersion,
		downloads: missing.map((m) => ({ ...m.download })),
		overrideEntries: [],
		zip: null
	};
	task.setProgress(0, 'Downloading pack files');
	const { failures } = await downloadPackFiles(pack, instance.path, task);
	await recordMissing(instance.path, failures);
	if (failures.length < missing.length) {
		task.setProgress(null, 'Identifying mods');
		const packFiles = new Set(missing.filter((m) => path.posix.dirname(m.download.target) === 'mods').map((m) => path.posix.basename(m.download.target)));
		await syncMods(instance, { packFiles, curseforge: curseforgeOrigins(pack) });
	}
	task.log(
		failures.length
			? `${missing.length - failures.length} of ${missing.length} downloaded; ${failures.length} still missing.`
			: `All ${missing.length} downloaded.`
	);
	return failures.length;
}
