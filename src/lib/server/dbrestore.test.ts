import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Its own task list: in a shared worker, other files' running tasks would block every request.
const tasks = vi.hoisted(() => ({ running: [] as { label: string; state: string }[] }));
vi.mock('./tasks', async (importOriginal) => ({ ...(await importOriginal<typeof import('./tasks')>()), listTasks: () => tasks.running }));
import { applyPendingRestore, PENDING_FILE, RESTORED_KEY } from './db/restore';
import { cancelPendingRestore, listDatabaseCopies, pendingRestore, previewRestore, requestRestore } from './dbrestore';
import { DB_BACKUP_DIR, dailyDatabaseCopy } from './dbbackups';
import { DATA_DIR } from './config';
import { db, raw } from './db';
import { settings } from './db/schema';
import { createInstance } from '../../../tests/helpers/instances';

/** A small database shaped like MineShell's: what applyPendingRestore reads and writes. */
function makeDb(file: string, value: string, opts: { operation?: boolean } = {}) {
	const d = new Database(file);
	d.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE operations (instance_id TEXT PRIMARY KEY, kind TEXT)');
	d.prepare('INSERT INTO settings VALUES (?, ?)').run('marker', value);
	if (opts.operation) {
		d.prepare("INSERT INTO operations VALUES ('alpha', 'pack-change')").run();
		d.prepare("INSERT INTO settings VALUES ('update.run', '{\"outcome\":\"running\"}')").run();
	}
	d.close();
}

const read = (file: string, key: string) => {
	const d = new Database(file, { readonly: true });
	try {
		return (d.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
	} finally {
		d.close();
	}
};

describe('putting a database copy in at start', () => {
	let dir: string;
	let dbPath: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-restore-'));
		dbPath = path.join(dir, 'mineshell.db');
		fs.mkdirSync(path.join(dir, 'db-backups'));
		makeDb(dbPath, 'now');
		fs.writeFileSync(`${dbPath}-wal`, 'stale');
	});

	it('does nothing without a request', () => {
		expect(applyPendingRestore(dir, dbPath)).toBeNull();
		expect(read(dbPath, 'marker')).toBe('now');
	});

	it('puts the copy in, without what it held mid-way, and says so in it', () => {
		makeDb(path.join(dir, 'db-backups', 'daily-2026-10-01.db'), 'then', { operation: true });
		fs.writeFileSync(path.join(dir, PENDING_FILE), JSON.stringify({ file: 'daily-2026-10-01.db', requestedAt: 1, by: 'owner' }));
		expect(applyPendingRestore(dir, dbPath)).toEqual({ file: 'daily-2026-10-01.db', error: null });
		expect(read(dbPath, 'marker')).toBe('then');
		// The copy's journal and update run are of its own moment: recovery must not act on them.
		const d = new Database(dbPath, { readonly: true });
		expect(d.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 0 });
		d.close();
		expect(read(dbPath, 'update.run')).toBeNull();
		expect(JSON.parse(read(dbPath, RESTORED_KEY)!)).toMatchObject({ file: 'daily-2026-10-01.db', by: 'owner' });
		// The old WAL belonged to the database replaced; the request is used up.
		expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
		expect(fs.existsSync(path.join(dir, PENDING_FILE))).toBe(false);
	});

	it('keeps the database as it was when the copy is damaged or gone, and says why', () => {
		fs.writeFileSync(path.join(dir, 'db-backups', 'daily-2026-10-02.db'), 'not a database');
		fs.writeFileSync(path.join(dir, PENDING_FILE), JSON.stringify({ file: 'daily-2026-10-02.db', requestedAt: 1, by: null }));
		expect(applyPendingRestore(dir, dbPath)?.error).toBeTruthy();
		expect(read(dbPath, 'marker')).toBe('now');
		expect(JSON.parse(fs.readFileSync(path.join(dir, 'restore-failed.json'), 'utf8'))).toMatchObject({ file: 'daily-2026-10-02.db' });
		// Not tried again at the next start.
		expect(applyPendingRestore(dir, dbPath)).toBeNull();
	});

	it('reads only from db-backups, whatever path the request names', () => {
		fs.writeFileSync(path.join(dir, PENDING_FILE), JSON.stringify({ file: '../mineshell.db', requestedAt: 1, by: null }));
		expect(applyPendingRestore(dir, dbPath)?.error).toMatch(/ENOENT/);
	});
});

describe('database copies in Settings', () => {
	beforeEach(async () => {
		fs.rmSync(DB_BACKUP_DIR(), { recursive: true, force: true });
		await cancelPendingRestore();
		tasks.running = [];
	});

	it('waits for a running task, which the restart would cut short', async () => {
		await dailyDatabaseCopy(new Date(2026, 9, 4, 12).getTime());
		tasks.running = [{ label: 'Installing a pack', state: 'running' }];
		await expect(requestRestore('daily-2026-10-04.db', null)).rejects.toThrow(/Wait for "Installing a pack"/);
		expect(await pendingRestore()).toBeNull();
	});

	it('lists the copies with what they hold, and what putting one back changes', async () => {
		const alpha = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', name: 'Alpha' });
		await dailyDatabaseCopy(new Date(2026, 9, 1, 12).getTime());
		const beta = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', name: 'Beta' });
		const [copy] = await listDatabaseCopies();
		expect(copy).toMatchObject({ file: 'daily-2026-10-01.db', kind: 'daily', refusal: null });
		expect(copy.servers.map((s) => s.id)).toContain(alpha.id);
		const preview = await previewRestore(copy.file);
		expect(preview.missing.map((s) => s.id)).toContain(beta.id);
		expect(preview.missing.map((s) => s.id)).not.toContain(alpha.id);
		// Reading them leaves nothing beside them (copies are out of WAL mode), nor changes when they say they were made.
		expect(fs.readdirSync(DB_BACKUP_DIR()).filter((f) => /-(wal|shm)$/.test(f))).toEqual([]);
		expect((await listDatabaseCopies())[0].madeAt).toBe(copy.madeAt);
	});

	it('refuses a copy from a newer MineShell, which this version could not read', async () => {
		fs.mkdirSync(DB_BACKUP_DIR(), { recursive: true });
		const file = path.join(DB_BACKUP_DIR(), 'daily-2026-10-02.db');
		await raw.backup(file);
		const d = new Database(file);
		d.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run('9999_from_the_future.sql', 1);
		d.close();
		const [copy] = await listDatabaseCopies();
		expect(copy.refusal).toMatch(/newer MineShell .*9999_from_the_future/);
		await expect(requestRestore(copy.file, null)).rejects.toThrow(/newer MineShell/);
	});

	it('keeps the database as it is before asking for the copy, which goes in at the next start', async () => {
		db.insert(settings).values({ key: 'dbrestore.test', value: 'now' }).onConflictDoUpdate({ target: settings.key, set: { value: 'now' } }).run();
		await dailyDatabaseCopy(new Date(2026, 9, 3, 12).getTime());
		// Not installed (tests run from a checkout): it waits for a restart instead of restarting.
		const { restarting, kept } = await requestRestore('daily-2026-10-03.db', 'owner');
		expect(restarting).toBe(false);
		expect(read(path.join(DB_BACKUP_DIR(), kept), 'dbrestore.test')).toBe('now');
		expect(await pendingRestore()).toMatchObject({ file: 'daily-2026-10-03.db', by: 'owner' });
		expect((await listDatabaseCopies()).map((c) => c.kind).sort()).toEqual(['before-restore', 'daily']);
		await cancelPendingRestore();
		expect(fs.existsSync(path.join(DATA_DIR, PENDING_FILE))).toBe(false);
	});
});
