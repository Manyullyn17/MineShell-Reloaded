import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../crypto';

const DIR = path.resolve('migrations');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

/** A database as an older MineShell left it: every migration before `upTo`. */
function databaseBefore(upTo: string) {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	for (const file of files.filter((f) => f < upTo)) sqlite.exec(fs.readFileSync(path.join(DIR, file), 'utf8'));
	return sqlite;
}
const apply = (sqlite: Database.Database, file: string) => sqlite.exec(fs.readFileSync(path.join(DIR, file), 'utf8'));

describe('migration 0019 (accounts)', () => {
	it('turns the admin password into the owner "admin" and keeps its sessions signed in', () => {
		const sqlite = databaseBefore('0019');
		const hash = hashPassword('old-password');
		sqlite.prepare("INSERT INTO settings (key, value) VALUES ('auth.password_hash', ?)").run(hash);
		sqlite.prepare('INSERT INTO sessions (id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)').run('s1', 1, Date.now() + 60_000, 'firefox');

		apply(sqlite, '0019_users.sql');

		const owner = sqlite.prepare('SELECT * FROM users').all() as { id: string; username: string; password_hash: string; is_owner: number }[];
		expect(owner).toHaveLength(1);
		expect(owner[0]).toMatchObject({ username: 'admin', is_owner: 1 });
		expect(owner[0].id).toMatch(/^[0-9a-f]{32}$/);
		expect(verifyPassword('old-password', owner[0].password_hash)).toBe(true);
		expect(sqlite.prepare("SELECT * FROM settings WHERE key = 'auth.password_hash'").get()).toBeUndefined();
		expect(sqlite.prepare('SELECT user_id FROM sessions WHERE id = ?').get('s1')).toEqual({ user_id: owner[0].id });
	});

	it('leaves a fresh install without an account, for setup to create', () => {
		const sqlite = databaseBefore('0019');
		sqlite.prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)').run('stray', 1, Date.now());
		apply(sqlite, '0019_users.sql');
		expect(sqlite.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 0 });
		expect(sqlite.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
	});
});
