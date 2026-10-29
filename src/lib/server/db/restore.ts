import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Putting a copy of MineShell's database back (dbrestore.ts asks for it). The
 * database is open for as long as MineShell runs, so the copy goes in at the
 * next start, before it opens: `restore-pending.json` in the data folder
 * names the copy, and db/index.ts calls this first.
 *
 * What the copy held mid-way is of its own moment, not of now: journals of
 * operations running when it was made (recovery would roll them back onto
 * today's files) and an update it was taken during. Both go.
 */

export const PENDING_FILE = 'restore-pending.json';
/** Written into the restored database's settings, for Settings to say what happened. */
export const RESTORED_KEY = 'database.restored';

export type PendingRestore = { file: string; requestedAt: number; by: string | null };

let applied = false;

/** This start put a copy in: the servers' units are re-synced from its rows (boot.ts). */
export function restoredThisStart(): boolean {
	return applied;
}

/** Applies a pending restore, if any; returns what was restored, or null. Never throws: a failure leaves the database as it was. */
export function applyPendingRestore(dataDir: string, dbPath: string): { file: string; error: string | null } | null {
	const marker = path.join(dataDir, PENDING_FILE);
	let pending: PendingRestore;
	try {
		pending = JSON.parse(fs.readFileSync(marker, 'utf8')) as PendingRestore;
	} catch {
		return null;
	}
	// Gone first: a copy that fails to go in must not be tried at every start.
	fs.rmSync(marker, { force: true });
	const source = path.join(dataDir, 'db-backups', path.basename(pending.file));
	const incoming = `${dbPath}.restoring`;
	try {
		fs.copyFileSync(source, incoming);
		const copy = new Database(incoming);
		try {
			if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('the copy is damaged');
			copy.exec('DELETE FROM operations');
			copy.prepare('DELETE FROM settings WHERE key = ?').run('update.run');
			const value = JSON.stringify({ file: path.basename(pending.file), at: Date.now(), by: pending.by });
			copy.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(RESTORED_KEY, value);
			copy.pragma('journal_mode = DELETE');
		} finally {
			copy.close();
		}
		for (const suffix of ['-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
		fs.renameSync(incoming, dbPath);
		applied = true;
		console.log(`[mineshell] restored the database from ${path.basename(pending.file)}`);
		return { file: path.basename(pending.file), error: null };
	} catch (err) {
		fs.rmSync(incoming, { force: true });
		const error = err instanceof Error ? err.message : String(err);
		console.warn(`[mineshell] restoring the database from ${pending.file} failed, kept as it was: ${error}`);
		fs.writeFileSync(path.join(dataDir, 'restore-failed.json'), JSON.stringify({ file: path.basename(pending.file), at: Date.now(), error }));
		return { file: path.basename(pending.file), error };
	}
}
