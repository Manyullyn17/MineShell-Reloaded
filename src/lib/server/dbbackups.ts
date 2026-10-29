import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { raw } from './db';
import { DATA_DIR } from './config';

/**
 * Copies of MineShell's own database (accounts, history, settings, the
 * server rows): `db-backups/` holds the ones made before each update
 * (selfupdate.ts) and one a day, kept apart so neither pushes the other out.
 * Made with SQLite's online backup, never a file copy: the database runs in
 * WAL mode, and a copied file can miss what is still in `-wal`.
 */
export const DB_BACKUP_DIR = () => path.join(DATA_DIR, 'db-backups');

export const DAILY_KEPT = 7;

/**
 * A whole copy of the database in `file`, out of WAL mode: the copy inherits
 * it, and a copy in WAL mode grows -wal and -shm files beside it as soon as
 * anything opens it, even to read, which a file copy of it would leave out.
 */
export async function copyDatabase(file: string): Promise<void> {
	await raw.backup(file);
	const copy = new Database(file);
	try {
		copy.pragma('journal_mode = DELETE');
	} finally {
		copy.close();
	}
}
const DAILY = /^daily-\d{4}-\d{2}-\d{2}\.db$/;

const localDate = (at: number) => {
	const d = new Date(at);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let making: Promise<string | null> | null = null;

/**
 * Today's copy, from the scheduler tick: made when there is none for today
 * yet, the oldest beyond DAILY_KEPT deleted. Resolves to the file made, or
 * null when today's was there already.
 */
export function dailyDatabaseCopy(now = Date.now()): Promise<string | null> {
	making ??= (async () => {
		const dir = DB_BACKUP_DIR();
		const file = path.join(dir, `daily-${localDate(now)}.db`);
		if (await fs.stat(file).catch(() => null)) return null;
		await fs.mkdir(dir, { recursive: true });
		// Written under another name first: a copy cut short must not count as today's.
		const partial = `${file}.part`;
		await copyDatabase(partial);
		await fs.rename(partial, file);
		const old = (await fs.readdir(dir)).filter((f) => DAILY.test(f)).sort().reverse().slice(DAILY_KEPT);
		for (const f of old) await fs.rm(path.join(dir, f), { force: true });
		return file;
	})().finally(() => {
		making = null;
	});
	return making;
}
