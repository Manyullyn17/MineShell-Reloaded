import fs from 'node:fs/promises';
import { utimesSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { serverInstances, settings } from './db/schema';
import { migrationSql } from './db/migrate';
import { PENDING_FILE, RESTORED_KEY, type PendingRestore } from './db/restore';
import { DATA_DIR } from './config';
import { copyDatabase, DB_BACKUP_DIR } from './dbbackups';
import { installInfo } from './selfupdate';
import { listTasks } from './tasks';
import { listOperations } from './operations';
import { run } from './systemd';

/**
 * Settings > Updates' "Database copies": the copies dbbackups.ts and
 * selfupdate.ts make, each told apart by what it holds, and putting one
 * back. The current database is copied first (`before-restore-<time>.db`),
 * so a restore can be undone the same way; the copy goes in at the next
 * start (db/restore.ts), which an installed MineShell does at once.
 */

export type DatabaseCopy = {
	file: string;
	kind: 'daily' | 'update' | 'before-restore';
	madeAt: number;
	bytes: number;
	servers: { id: string; name: string }[];
	accounts: number;
	/** Why it cannot be put back by this version, or null. */
	refusal: string | null;
};

const KINDS: [RegExp, DatabaseCopy['kind']][] = [
	[/^daily-\d{4}-\d{2}-\d{2}\.db$/, 'daily'],
	[/^mineshell-.+\.db$/, 'update'],
	[/^before-restore-[\w-]+\.db$/, 'before-restore']
];

/**
 * What a copy holds, changing nothing in it but its journal mode: copies made
 * before copyDatabase are in WAL mode, which grows -wal and -shm files beside
 * a copy whenever it is opened, read-only too. Its modification time, which
 * says when it was made, is put back after.
 */
function inspect(file: string, made: Date): Pick<DatabaseCopy, 'servers' | 'accounts' | 'refusal'> {
	let copy: Database.Database | null = null;
	try {
		copy = new Database(file, { fileMustExist: true });
		copy.pragma('journal_mode = DELETE');
		const tables = new Set((copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
		if (!tables.has('server_instances') || !tables.has('_migrations')) return { servers: [], accounts: 0, refusal: 'It is not a MineShell database.' };
		const servers = copy.prepare('SELECT id, name FROM server_instances ORDER BY name').all() as { id: string; name: string }[];
		const accounts = tables.has('users') ? (copy.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n : 0;
		// A newer MineShell's changes this version does not know: it could not read them.
		const unknown = (copy.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((m) => m.name).filter((name) => migrationSql(name) === null);
		const refusal = unknown.length
			? `It is from a newer MineShell (database changes ${unknown.map((n) => n.replace(/\.sql$/, '')).join(', ')}): update to that version first.`
			: null;
		return { servers, accounts, refusal };
	} catch (err) {
		return { servers: [], accounts: 0, refusal: `It cannot be read: ${err instanceof Error ? err.message : 'unknown error'}.` };
	} finally {
		copy?.close();
		try {
			utimesSync(file, made, made);
		} catch {
			/* gone meanwhile */
		}
	}
}

/** Every copy, newest first. */
export async function listDatabaseCopies(): Promise<DatabaseCopy[]> {
	const dir = DB_BACKUP_DIR();
	const out: DatabaseCopy[] = [];
	for (const file of await fs.readdir(dir).catch(() => [] as string[])) {
		const kind = KINDS.find(([re]) => re.test(file))?.[1];
		if (!kind) continue;
		const stat = await fs.stat(path.join(dir, file)).catch(() => null);
		if (!stat?.isFile()) continue;
		const held = inspect(path.join(dir, file), stat.mtime);
		out.push({ file, kind, madeAt: Math.round(stat.mtimeMs), bytes: (await fs.stat(path.join(dir, file)).catch(() => stat)).size, ...held });
	}
	return out.sort((a, b) => b.madeAt - a.madeAt);
}

export type RestorePreview = {
	copy: DatabaseCopy;
	/** Servers made since: their rows go, their folders stay on disk. */
	missing: { id: string; name: string; path: string }[];
	/** Servers deleted since: their rows come back, whether or not their folders still exist. */
	returning: { id: string; name: string }[];
};

export async function previewRestore(file: string): Promise<RestorePreview> {
	const copy = (await listDatabaseCopies()).find((c) => c.file === file);
	if (!copy) throw new Error('That copy is no longer there.');
	const now = db.select({ id: serverInstances.id, name: serverInstances.name, path: serverInstances.path }).from(serverInstances).all();
	const then = new Set(copy.servers.map((s) => s.id));
	return {
		copy,
		missing: now.filter((s) => !then.has(s.id)).sort((a, b) => a.name.localeCompare(b.name)),
		returning: copy.servers.filter((s) => !now.some((n) => n.id === s.id))
	};
}

/** Why a restore cannot be asked for now, or null. */
export function restoreBlocker(): string | null {
	const busy = listTasks().find((t) => t.state === 'running');
	if (busy) return `Wait for "${busy.label}" to finish: putting the database back restarts MineShell, which would cut it short.`;
	if (listOperations().length) return 'A server is in the middle of a change: wait for it to finish.';
	return null;
}

/** Copies of the database a restore replaced, newest kept. */
const BEFORE_RESTORE_KEPT = 3;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/**
 * Asks for `file` to be put back: the current database is copied first, then
 * the marker is written and an installed MineShell restarts (as a transient
 * unit, which outlives this process). Returns whether it restarts by itself.
 */
export async function requestRestore(file: string, by: string | null): Promise<{ restarting: boolean; kept: string }> {
	const blocker = restoreBlocker();
	if (blocker) throw new Error(blocker);
	const { copy } = await previewRestore(file);
	if (copy.refusal) throw new Error(copy.refusal);
	const dir = DB_BACKUP_DIR();
	await fs.mkdir(dir, { recursive: true });
	const kept = `before-restore-${stamp()}.db`;
	await copyDatabase(path.join(dir, kept));
	const old = (await fs.readdir(dir)).filter((f) => KINDS[2][0].test(f)).sort().reverse().slice(BEFORE_RESTORE_KEPT);
	for (const f of old) await fs.rm(path.join(dir, f), { force: true });
	const pending: PendingRestore = { file: copy.file, requestedAt: Date.now(), by };
	await fs.writeFile(path.join(DATA_DIR, PENDING_FILE), JSON.stringify(pending));
	const install = installInfo();
	if (!install) return { restarting: false, kept };
	const started = await run([
		'systemd-run',
		'--user',
		`--unit=${install.service}-restore-${Date.now()}`,
		'--collect',
		'--quiet',
		'--description=MineShell restart to put a database copy back',
		'systemctl',
		'--user',
		'restart',
		install.service
	]);
	if (started.code !== 0) throw new Error(`The copy is set to go in at the next start, but MineShell could not restart itself: ${started.stderr.trim()}`);
	return { restarting: true, kept };
}

/** A restore asked for and not yet applied (MineShell not restarted since). */
export async function pendingRestore(): Promise<PendingRestore | null> {
	return fs
		.readFile(path.join(DATA_DIR, PENDING_FILE), 'utf8')
		.then((t) => JSON.parse(t) as PendingRestore)
		.catch(() => null);
}

export async function cancelPendingRestore(): Promise<void> {
	await fs.rm(path.join(DATA_DIR, PENDING_FILE), { force: true });
}

/** The last restore, as the start that applied it recorded: done (in the database), or failed (beside it). */
export async function lastRestore(): Promise<{ file: string; at: number; error: string | null } | null> {
	const failed = await fs
		.readFile(path.join(DATA_DIR, 'restore-failed.json'), 'utf8')
		.then((t) => JSON.parse(t) as { file: string; at: number; error: string })
		.catch(() => null);
	const row = db.select().from(settings).where(eq(settings.key, RESTORED_KEY)).get();
	const done = row ? (JSON.parse(row.value) as { file: string; at: number }) : null;
	if (failed && (!done || failed.at > done.at)) return failed;
	return done && { ...done, error: null };
}

export async function dismissLastRestore(): Promise<void> {
	db.delete(settings).where(eq(settings.key, RESTORED_KEY)).run();
	await fs.rm(path.join(DATA_DIR, 'restore-failed.json'), { force: true });
}
