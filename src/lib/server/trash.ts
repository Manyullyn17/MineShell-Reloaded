import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings } from './db/schema';
import { directorySize, safeJoin } from './files';

/**
 * Files deleted in the Files tab go to `.mineshell/trash/` first: each as
 * `<id>/<name>` beside `<id>.json` (where it was, when). Restored by renaming
 * back; emptied by hand or once older than the setting's days (scheduler).
 * The JSON is written before the move, so a crash between them leaves a
 * record without a folder, which listing drops - never a folder nobody knows.
 */

export const TRASH_DIR = path.join('.mineshell', 'trash');
const DAYS_KEY = 'files.trashDays';
export const DEFAULT_TRASH_DAYS = 7;
export const MAX_TRASH_DAYS = 365;

export type TrashItem = {
	id: string;
	/** Where it was, relative to the server folder. */
	path: string;
	deletedAt: number;
	isDirectory: boolean;
	bytes: number;
};

/** Days a deleted file is kept; 0 = deleting skips the trash. */
export function trashDays(): number {
	const raw = db.select().from(settings).where(eq(settings.key, DAYS_KEY)).get()?.value;
	const days = raw === undefined ? NaN : Number(raw);
	return Number.isInteger(days) && days >= 0 && days <= MAX_TRASH_DAYS ? days : DEFAULT_TRASH_DAYS;
}

export function setTrashDays(days: number): void {
	if (!Number.isInteger(days) || days < 0 || days > MAX_TRASH_DAYS) {
		throw new Error(`Keep deleted files 0 to ${MAX_TRASH_DAYS} days.`);
	}
	const value = String(days);
	db.insert(settings).values({ key: DAYS_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

/** The trash itself, or anything it is inside: those cannot be moved into it. */
export function holdsTrash(relative: string): boolean {
	const rel = path.normalize(relative.replace(/^[/\\]+/, '')).split(path.sep).join('/');
	const trash = TRASH_DIR.split(path.sep).join('/');
	return rel === trash || rel.startsWith(`${trash}/`) || trash.startsWith(`${rel}/`);
}

/** Rename, or copy and remove when the trash is on another filesystem (a mounted world folder). */
async function move(from: string, to: string): Promise<void> {
	try {
		await fs.rename(from, to);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
		await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
		await fs.rm(from, { recursive: true, force: true });
	}
}

/**
 * Delete `relative`: into the trash, or for good when the trash is off or the
 * path is the trash (or inside it, or holds it). Returns the trash item, or
 * null when it was deleted for good.
 */
export async function deleteToTrash(root: string, relative: string): Promise<TrashItem | null> {
	const target = safeJoin(root, relative);
	if (target === path.resolve(root)) throw new Error('The instance root cannot be deleted here.');
	const rel = path.relative(path.resolve(root), target);
	if (trashDays() === 0 || holdsTrash(rel)) {
		await fs.rm(target, { recursive: true, force: true });
		return null;
	}
	const stat = await fs.lstat(target);
	const trash = path.join(root, TRASH_DIR);
	await fs.mkdir(trash, { recursive: true });
	// Random part: two deletes in one millisecond must not share a name.
	const id = `${Date.now()}-${randomBytes(3).toString('hex')}`;
	const item: TrashItem = { id, path: rel.split(path.sep).join('/'), deletedAt: Date.now(), isDirectory: stat.isDirectory(), bytes: stat.size };
	const record = path.join(trash, `${id}.json`);
	await fs.writeFile(record, JSON.stringify(item));
	try {
		await fs.mkdir(path.join(trash, id));
		await move(target, path.join(trash, id, path.basename(target)));
	} catch (err) {
		await fs.rm(path.join(trash, id), { recursive: true, force: true }).catch(() => undefined);
		await fs.rm(record, { force: true });
		throw err;
	}
	if (item.isDirectory) {
		item.bytes = await directorySize(path.join(trash, id));
		await fs.writeFile(record, JSON.stringify(item));
	}
	return item;
}

async function readItem(trash: string, id: string): Promise<TrashItem | null> {
	try {
		const item = JSON.parse(await fs.readFile(path.join(trash, `${id}.json`), 'utf8')) as TrashItem;
		return item.id === id && typeof item.path === 'string' && typeof item.deletedAt === 'number' ? item : null;
	} catch {
		return null;
	}
}

/** What is in the trash, newest first. Records whose folder is gone are dropped. */
export async function listTrash(root: string): Promise<TrashItem[]> {
	const trash = path.join(root, TRASH_DIR);
	const names = await fs.readdir(trash).catch(() => [] as string[]);
	const folders = new Set(names.filter((n) => !n.endsWith('.json')));
	const items: TrashItem[] = [];
	for (const name of names) {
		if (!name.endsWith('.json')) continue;
		const id = name.slice(0, -'.json'.length);
		const item = folders.has(id) ? await readItem(trash, id) : null;
		if (item) items.push(item);
		else if (!folders.has(id)) await fs.rm(path.join(trash, name), { force: true });
	}
	return items.sort((a, b) => b.deletedAt - a.deletedAt);
}

function validId(id: string): boolean {
	return /^\d+-[0-9a-f]+$/.test(id);
}

/** A free name next to `rel`: "name (restored)", "name (restored 2)", ... */
async function freeName(root: string, rel: string): Promise<string> {
	if (!(await exists(safeJoin(root, rel)))) return rel;
	const dir = path.posix.dirname(rel);
	const base = path.posix.basename(rel);
	const ext = path.posix.extname(base);
	const stem = ext && ext !== base ? base.slice(0, -ext.length) : base;
	const suffix = ext && ext !== base ? ext : '';
	for (let n = 1; ; n++) {
		const name = `${stem} (restored${n === 1 ? '' : ` ${n}`})${suffix}`;
		const candidate = dir === '.' ? name : path.posix.join(dir, name);
		if (!(await exists(safeJoin(root, candidate)))) return candidate;
	}
}

async function exists(full: string): Promise<boolean> {
	return fs.lstat(full).then(
		() => true,
		() => false
	);
}

/**
 * Put an item back where it was (its folders made again if they are gone). If
 * something has taken its place since, it comes back beside it, renamed.
 * Returns where it went.
 */
export async function restoreFromTrash(root: string, id: string): Promise<string> {
	const trash = path.join(root, TRASH_DIR);
	const item = validId(id) ? await readItem(trash, id) : null;
	if (!item) throw new Error('That is no longer in the trash.');
	const inside = await fs.readdir(path.join(trash, id)).catch(() => [] as string[]);
	if (inside.length !== 1) throw new Error('That is no longer in the trash.');
	const to = await freeName(root, item.path);
	const target = safeJoin(root, to);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await move(path.join(trash, id, inside[0]), target);
	await fs.rm(path.join(trash, id), { recursive: true, force: true });
	await fs.rm(path.join(trash, `${id}.json`), { force: true });
	return to;
}

/** Delete one item for good. */
export async function purgeTrashItem(root: string, id: string): Promise<void> {
	if (!validId(id)) throw new Error('That is no longer in the trash.');
	const trash = path.join(root, TRASH_DIR);
	// Folder first: a record without its folder is dropped by listing, the other way round would not be.
	await fs.rm(path.join(trash, id), { recursive: true, force: true });
	await fs.rm(path.join(trash, `${id}.json`), { force: true });
}

/** Empty the trash; with `olderThan`, only items deleted before it. Returns how many went. */
export async function emptyTrash(root: string, olderThan?: number): Promise<number> {
	let count = 0;
	for (const item of await listTrash(root)) {
		if (olderThan !== undefined && item.deletedAt >= olderThan) continue;
		await purgeTrashItem(root, item.id);
		count++;
	}
	if (olderThan === undefined) {
		// Whatever else is in there (a folder whose record was removed by hand).
		await fs.rm(path.join(root, TRASH_DIR), { recursive: true, force: true });
	}
	return count;
}

/** The scheduler's part: items past the kept days go. */
export async function expireTrash(root: string, now = Date.now()): Promise<number> {
	const days = trashDays();
	// Off (0) only stops new items going in; what is there still waits its default time.
	const keep = (days || DEFAULT_TRASH_DAYS) * 86_400_000;
	return emptyTrash(root, now - keep);
}
