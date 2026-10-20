import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { downloadedFiles } from './db/schema';

/**
 * Downloads that come with a hash (mods, packs' files, data packs, loader
 * jars) are recorded with it; a later download of the same content copies
 * one of those files instead of fetching it again - a second server on the
 * same pack, an update reinstalled, a copy's pack change.
 *
 * Keyed on content only, never on a name or version label: packs ship
 * patched jars under upstream version numbers, which is why mods were always
 * downloaded fresh before. A recorded file is hashed again before it is
 * copied, so one changed, moved or replaced since is never used (its record
 * goes). Copies are reflinks where the filesystem has them (btrfs, XFS).
 */

export type FileHash = { algo: string; value: string };

async function digest(file: string, algo: string): Promise<string | null> {
	try {
		const hasher = crypto.createHash(algo);
		const handle = await fs.open(file, 'r');
		try {
			for await (const chunk of handle.createReadStream()) hasher.update(chunk as Buffer);
		} finally {
			await handle.close();
		}
		return hasher.digest('hex');
	} catch {
		return null;
	}
}

/** After a download whose hash was checked: where that content now is. */
export async function recordDownload(file: string, hash: FileHash): Promise<void> {
	const size = (await fs.stat(file).catch(() => null))?.size;
	if (size === undefined) return;
	const row = { path: path.resolve(file), algo: hash.algo, hash: hash.value.toLowerCase(), size, recordedAt: Date.now() };
	db.insert(downloadedFiles).values(row).onConflictDoUpdate({ target: downloadedFiles.path, set: row }).run();
}

/**
 * Writes `temp` from a recorded file with this content, if one still has it.
 * True when it did; records that no longer match are dropped on the way.
 */
export async function copyFromEarlierDownload(hash: FileHash, temp: string, destination: string): Promise<boolean> {
	// Test files in one worker share a database; one file's download must not stand in for another's (tests/setup.ts).
	if ((globalThis as { __mineshellFileCache?: boolean }).__mineshellFileCache === false) return false;
	const value = hash.value.toLowerCase();
	const rows = db
		.select()
		.from(downloadedFiles)
		.where(and(eq(downloadedFiles.algo, hash.algo), eq(downloadedFiles.hash, value)))
		.all();
	for (const row of rows) {
		if (row.path === path.resolve(destination)) continue;
		if ((await digest(row.path, hash.algo)) !== value) {
			db.delete(downloadedFiles).where(eq(downloadedFiles.path, row.path)).run();
			continue;
		}
		try {
			await fs.copyFile(row.path, temp, fsConstants.COPYFILE_FICLONE);
		} catch {
			continue;
		}
		// Read back: the copy is what gets used, so it is what is checked.
		if ((await digest(temp, hash.algo)) === value) return true;
		await fs.rm(temp, { force: true });
	}
	return false;
}
