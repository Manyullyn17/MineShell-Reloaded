import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import yazl from 'yazl';
import type { ServerInstance } from './db/schema';
import { safeJoin } from './files';
import { cloneSkips, InstanceError, summarise } from './instances';
import { freeSpace, getSnapshotPolicy, worldFolders } from './snapshots';
import { deleteToTrash, holdsTrash } from './trash';
import { entryStream, openZip, pauseSaving, STORED, zipEntries } from './world';
import { formatBytes } from '#lib/shared/format.js';

/**
 * Zips in Files, both ways: a folder downloads as a zip, streamed while it is
 * made, and an uploaded zip unpacks where it lies or into a folder named after
 * it. The zip is not trusted: an entry whose path leaves the folder it unpacks
 * into refuses the whole zip, and what it would replace is asked about first
 * and then goes to the trash, as a delete does.
 */

/** Shown by name when an unpack asks before replacing; the rest are counted. */
export const CONFLICTS_SHOWN = 20;

/** Left out of a download: the copying server's lock, and the folders a server copy leaves out (snapshots, the trash...). */
function leftOut(rel: string): boolean {
	return path.posix.basename(rel) === 'session.lock' || cloneSkips(rel);
}

/** Whether `a` is `b`, inside it, or holds it (relative paths, '' the server folder). */
function overlaps(a: string, b: string): boolean {
	return a === b || a === '' || b === '' || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * A folder of the server (`''` the whole of it) as a zip, entries named from
 * inside it. When it holds the active world, or is inside it, a running
 * server stops saving until the zip is done, as the World tab's download does.
 */
export async function zipFolder(instance: ServerInstance, folder: string): Promise<{ stream: Readable; fileName: string }> {
	const dir = safeJoin(instance.path, folder);
	const rel = path.relative(path.resolve(instance.path), dir).split(path.sep).join('/');
	if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) throw new InstanceError('No such folder.');

	const files: { abs: string; name: string }[] = [];
	async function walk(abs: string, name: string): Promise<void> {
		for (const entry of await fs.readdir(abs, { withFileTypes: true }).catch(() => [])) {
			const child = name ? `${name}/${entry.name}` : entry.name;
			// What a copy of the server leaves out, unless that is the folder asked for.
			if (leftOut(rel ? `${rel}/${child}` : child)) continue;
			if (entry.isDirectory()) await walk(path.join(abs, entry.name), child);
			else if (entry.isFile()) files.push({ abs: path.join(abs, entry.name), name: child });
		}
	}
	await walk(dir, '');

	const fileName = `${rel ? path.posix.basename(rel) : instance.id}.zip`;
	const live = (await worldFolders(instance.path)).some((world) => overlaps(rel, world)) && (await summarise(instance)).running;
	const resume = live ? await pauseSaving(instance, 'this folder') : null;
	try {
		const zip = new yazl.ZipFile();
		for (const file of files) zip.addFile(file.abs, file.name, { compress: !STORED.test(file.name) });
		zip.end();
		const stream = zip.outputStream as Readable;
		if (resume) for (const event of ['close', 'end', 'error']) stream.once(event, resume);
		return { stream, fileName };
	} catch (err) {
		resume?.();
		throw err;
	}
}

export type UnpackInto = 'here' | 'folder';

export type UnpackPlan = {
	/** Where it unpacks to, relative to the server folder ('' the server folder). */
	target: string;
	/** Entries and the folder each lands in. */
	entries: { name: string; out: string; directory: boolean }[];
	bytes: number;
	/** What is there already and would be replaced, relative to the server folder. */
	conflicts: string[];
};

export class UnpackConflict extends Error {
	constructor(readonly plan: UnpackPlan) {
		super(`Unpacking would replace ${plan.conflicts.length} file${plan.conflicts.length === 1 ? '' : 's'} or folder${plan.conflicts.length === 1 ? '' : 's'}.`);
	}
}

/** Mac zips carry these beside every file; nothing on a server reads them. */
function macClutter(name: string): boolean {
	return name.startsWith('__MACOSX/') || path.posix.basename(name) === '.DS_Store';
}

/**
 * Where each of the zip's entries would go and what is in the way, without
 * writing anything. Into a folder named after the zip: a zip that already
 * holds everything in a folder of that name does not get it twice
 * (`pack.zip` holding `pack/...` unpacks to `pack/`, not `pack/pack/`).
 */
export async function planUnpack(root: string, zipRel: string, into: UnpackInto): Promise<UnpackPlan> {
	const zipFile = safeJoin(root, zipRel);
	const rel = path.relative(path.resolve(root), zipFile).split(path.sep).join('/');
	const parent = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
	const own = path.posix.basename(rel).replace(/\.zip$/i, '');
	if (into === 'folder' && !own) throw new InstanceError('That zip has no name to name a folder after.');
	const target = into === 'folder' ? path.posix.join(parent, own) : parent;
	if (target && holdsTrash(target)) throw new InstanceError('Nothing can be unpacked into the trash.');

	let listing: { name: string; size: number }[] = [];
	const zip = await openZip(zipFile).catch(() => {
		throw new InstanceError('That file is not a readable zip.');
	});
	try {
		await zipEntries(zip, async (entry) => {
			listing.push({ name: entry.fileName, size: entry.uncompressedSize });
		});
	} catch (err) {
		// yauzl refuses those names itself, before they reach the check below.
		const message = err instanceof Error ? err.message : '';
		if (/^(absolute path|invalid relative path)/.test(message)) {
			throw new InstanceError(`That zip is refused: ${message.replace(/^[^:]*:\s*/, '')} would land outside the folder it unpacks into.`);
		}
		throw new InstanceError('That zip is damaged.');
	} finally {
		zip.close();
	}
	listing = listing.filter((e) => !macClutter(e.name));
	if (!listing.length) throw new InstanceError('That zip is empty.');

	const strip = into === 'folder' && listing.every((e) => e.name.startsWith(`${own}/`)) ? `${own}/` : '';
	const entries: UnpackPlan['entries'] = [];
	for (const { name } of listing) {
		const inner = name.slice(strip.length).replace(/\\/g, '/');
		if (!inner) continue;
		const normal = path.posix.normalize(inner);
		if (inner.startsWith('/') || /^[a-z]:/i.test(inner) || normal === '..' || normal.startsWith('../')) {
			throw new InstanceError(`That zip is refused: ${name} would land outside the folder it unpacks into.`);
		}
		if (normal === '.' || normal === './') continue;
		const out = path.posix.join(target, normal.replace(/\/$/, ''));
		if (holdsTrash(out)) throw new InstanceError(`That zip is refused: ${name} would land in the trash.`);
		entries.push({ name, out, directory: name.endsWith('/') });
	}

	// In the way: an existing file where the zip has anything, or an existing
	// folder where it has a file; both for the entries and the folders above them.
	const conflicts = new Set<string>();
	const checked = new Map<string, Awaited<ReturnType<typeof fs.lstat>> | null>();
	const statOf = async (p: string) => {
		if (!checked.has(p)) checked.set(p, await fs.lstat(path.join(root, p)).catch(() => null));
		return checked.get(p)!;
	};
	for (const entry of entries) {
		const parts = entry.out.split('/');
		const above = target ? target.split('/').length : 0;
		for (let i = above + 1; i < parts.length; i++) {
			const folder = parts.slice(0, i).join('/');
			const stat = await statOf(folder);
			if (stat && !stat.isDirectory()) conflicts.add(folder);
		}
		const stat = await statOf(entry.out);
		if (stat && (entry.directory ? !stat.isDirectory() : true)) conflicts.add(entry.out);
	}
	if (entries.some((e) => e.out === rel)) throw new InstanceError('That zip holds a file of its own name; unpack it into a folder instead.');
	const bytes = listing.reduce((sum, e) => sum + e.size, 0);
	return { target, entries, bytes, conflicts: [...conflicts].sort() };
}

/**
 * Unpacks the zip. Refused when what it holds would leave less free on the
 * disk than snapshots keep free, and (unless `replace`) when it would replace
 * anything (UnpackConflict, with the plan). Replaced files go to the trash.
 */
export async function unpackZip(
	instance: ServerInstance,
	zipRel: string,
	into: UnpackInto,
	opts: { replace: boolean }
): Promise<{ target: string; files: number; replaced: number }> {
	const root = instance.path;
	const plan = await planUnpack(root, zipRel, into);
	if (plan.conflicts.length && !opts.replace) throw new UnpackConflict(plan);
	const free = await freeSpace(root);
	const keepFree = getSnapshotPolicy(instance.id).minFreeMb * 1024 * 1024;
	if (free !== null && free - plan.bytes < keepFree) {
		throw new InstanceError(
			`That zip unpacks to ${formatBytes(plan.bytes)}, and only ${formatBytes(free)} is free on the server's disk: it would leave less than the ${formatBytes(keepFree)} kept free (Settings > Snapshots).`
		);
	}
	const zipFile = safeJoin(root, zipRel);
	// One may be gone with another already (a folder in the way, and a file the zip puts inside it).
	for (const conflict of plan.conflicts) if (await fs.lstat(path.join(root, conflict)).catch(() => null)) await deleteToTrash(root, conflict);

	const outOf = new Map(plan.entries.map((e) => [e.name, e]));
	let files = 0;
	const zip = await openZip(zipFile);
	try {
		await zipEntries(zip, async (entry) => {
			const planned = outOf.get(entry.fileName);
			if (!planned) return;
			const out = path.join(root, planned.out);
			if (planned.directory) {
				await fs.mkdir(out, { recursive: true });
				return;
			}
			await fs.mkdir(path.dirname(out), { recursive: true });
			await pipeline(await entryStream(zip, entry), createWriteStream(out));
			files++;
		});
	} finally {
		zip.close();
	}
	await fs.mkdir(path.join(root, plan.target), { recursive: true });
	return { target: plan.target, files, replaced: plan.conflicts.length };
}
