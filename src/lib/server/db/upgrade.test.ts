import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrate';

const DIR = path.resolve('migrations');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

/**
 * An update can skip any number of releases (0.12 straight to the newest):
 * every migration not yet applied then runs in one go, against a database
 * with data in it. A fresh database hides what only fails with rows there (a
 * NOT NULL column without a default, a copy into a rebuilt table), so each
 * starting point gets a row in every table first.
 */

/** A database as MineShell left it after the first `count` migrations, its own bookkeeping included. */
function installedAt(count: number) {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	sqlite.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)');
	for (const file of files.slice(0, count)) {
		sqlite.exec(fs.readFileSync(path.join(DIR, file), 'utf8'));
		sqlite.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, 1);
	}
	return sqlite;
}

/**
 * One row in every table. Every value is the same per type (1, 'x'), so a
 * foreign key names a row that exists once all are in (a table can gain a
 * reference to one made after it, so keys are checked afterwards).
 */
function fill(sqlite: Database.Database): number {
	sqlite.pragma('foreign_keys = OFF');
	const tables = sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' ORDER BY rowid")
		.all() as { name: string }[];
	let filled = 0;
	for (const { name } of tables) {
		const columns = sqlite.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; type: string }[];
		const value = (type: string) => (/INT/i.test(type) ? 1 : /REAL|FLOA|DOUB/i.test(type) ? 1.5 : /BLOB/i.test(type) ? Buffer.from('x') : 'x');
		const list = columns.map((c) => `"${c.name}"`).join(', ');
		const marks = columns.map(() => '?').join(', ');
		filled += sqlite.prepare(`INSERT OR IGNORE INTO "${name}" (${list}) VALUES (${marks})`).run(...columns.map((c) => value(c.type))).changes;
	}
	sqlite.pragma('foreign_keys = ON');
	expect(sqlite.pragma('foreign_key_check')).toEqual([]);
	return filled;
}

describe('updating from any earlier version', () => {
	it.each(files.map((_, i) => i).filter((i) => i > 0))('migrates a database with data from after migration %i to the newest', (count) => {
		const sqlite = installedAt(count);
		expect(fill(sqlite)).toBeGreaterThan(0);
		runMigrations(sqlite);
		const applied = (sqlite.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]).map((r) => r.name);
		expect(applied).toEqual(files);
		expect(sqlite.pragma('foreign_key_check')).toEqual([]);
		expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
	});
});
