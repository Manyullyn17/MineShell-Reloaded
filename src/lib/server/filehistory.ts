import fs from 'node:fs/promises';
import path from 'node:path';
import { safeJoin } from './files';

/**
 * Earlier versions of files edited in MineShell. Each save from the file
 * editor keeps the text it replaced, so one broken config can be put back
 * without a snapshot (snapshots hold only the world). Going back is itself a
 * save, so it can be undone the same way. Only MineShell's own saves count:
 * a mod rewriting its config, or an edit over SFTP, keeps nothing.
 *
 * `.mineshell/file-history/<path>.versions/<saved at, ms>`, the old bytes as
 * they were. Left out of exports and copies (cloneSkips).
 */

export const HISTORY_DIR = path.join('.mineshell', 'file-history');
/** Versions kept per file. */
export const KEEP = 20;
/** Older ones go, apart from the newest KEEP_ALWAYS. */
const MAX_AGE_MS = 90 * 24 * 3600_000;
const KEEP_ALWAYS = 3;

export type FileVersion = { id: string; savedAt: number; bytes: number };

function versionsDir(root: string, relative: string): string {
	const rel = path.relative(path.resolve(root), safeJoin(root, relative));
	if (!rel || rel.startsWith('..')) throw new Error('Not a file in the server folder.');
	return path.join(root, HISTORY_DIR, `${rel}.versions`);
}

export async function listVersions(root: string, relative: string): Promise<FileVersion[]> {
	const dir = versionsDir(root, relative);
	const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => /^\d+$/.test(n));
	const versions = await Promise.all(
		names.map(async (id) => ({ id, savedAt: Number(id), bytes: (await fs.stat(path.join(dir, id)).catch(() => null))?.size ?? 0 }))
	);
	return versions.sort((a, b) => b.savedAt - a.savedAt);
}

export async function readVersion(root: string, relative: string, id: string): Promise<string> {
	if (!/^\d+$/.test(id)) throw new Error('No such version.');
	return fs.readFile(path.join(versionsDir(root, relative), id), 'utf8');
}

/**
 * Before a save: keeps the file as it is now, unless it does not exist yet or
 * the save changes nothing (line endings aside, which the save keeps).
 */
export async function keepVersion(root: string, relative: string, incoming: string, now = Date.now()): Promise<boolean> {
	const current = await fs.readFile(safeJoin(root, relative)).catch(() => null);
	if (!current) return false;
	const lf = (text: string) => text.replace(/\r\n/g, '\n');
	if (lf(current.toString('utf8')) === lf(incoming)) return false;
	const dir = versionsDir(root, relative);
	await fs.mkdir(dir, { recursive: true });
	let at = now;
	while (await fs.access(path.join(dir, String(at))).then(() => true, () => false)) at++;
	await fs.writeFile(path.join(dir, String(at)), current);
	await prune(dir, now);
	return true;
}

async function prune(dir: string, now: number): Promise<void> {
	const ids = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a));
	const gone = ids.filter((id, i) => i >= KEEP || (i >= KEEP_ALWAYS && now - Number(id) > MAX_AGE_MS));
	for (const id of gone) await fs.rm(path.join(dir, id), { force: true });
}
