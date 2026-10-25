import fs from 'node:fs';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { DAILY_KEPT, DB_BACKUP_DIR, dailyDatabaseCopy } from './dbbackups';
import { db } from './db';
import { settings } from './db/schema';

const day = (n: number) => new Date(2026, 9, n, 12).getTime();

beforeEach(() => {
	fs.rmSync(DB_BACKUP_DIR(), { recursive: true, force: true });
});

describe('daily copy of the database', () => {
	it('makes one a day, a whole database with what is still in the WAL', async () => {
		db.insert(settings).values({ key: 'dbbackups.test', value: 'kept' }).onConflictDoNothing().run();
		const file = await dailyDatabaseCopy(day(3));
		expect(file).toMatch(/daily-2026-10-03\.db$/);
		const copy = new Database(file!, { readonly: true });
		try {
			expect(copy.prepare("SELECT value FROM settings WHERE key = 'dbbackups.test'").get()).toEqual({ value: 'kept' });
		} finally {
			copy.close();
		}
		expect(await dailyDatabaseCopy(day(3) + 3_600_000)).toBeNull();
	});

	it(`keeps the newest ${DAILY_KEPT}, and leaves the copies made before updates alone`, async () => {
		fs.mkdirSync(DB_BACKUP_DIR(), { recursive: true });
		fs.writeFileSync(`${DB_BACKUP_DIR()}/mineshell-2000-01-01-0.1.0-to-0.2.0.db`, '');
		for (let n = 1; n <= DAILY_KEPT + 2; n++) await dailyDatabaseCopy(day(n));
		const files = fs.readdirSync(DB_BACKUP_DIR()).sort();
		expect(files.filter((f) => f.startsWith('daily-'))).toHaveLength(DAILY_KEPT);
		expect(files[0]).toBe('daily-2026-10-03.db');
		expect(files).toContain('mineshell-2000-01-01-0.1.0-to-0.2.0.db');
	});
});
