import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { downgradeSafe, migrationSql } from './migrate';

const DIR = path.resolve('migrations');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

describe('downgrade markers', () => {
	// Going back to an older release (selfupdate.ts) reads them: each migration says
	// whether an older MineShell still works with it applied.
	it.each(files)('%s says whether an older MineShell copes with it', (file) => {
		expect(fs.readFileSync(path.join(DIR, file), 'utf8').split('\n')[0]).toMatch(/^-- downgrade: (safe$|unsafe - \S)/);
	});

	it('marks the accounts migration unsafe: it moves the password an older version reads', () => {
		expect(downgradeSafe(migrationSql('0019_users.sql')!)).toBe(false);
		expect(downgradeSafe(migrationSql('0018_server_tags.sql')!)).toBe(true);
	});

	it('counts a migration without the line as unsafe', () => {
		expect(downgradeSafe('CREATE TABLE x (id TEXT);')).toBe(false);
		expect(migrationSql('9999_none.sql')).toBeNull();
	});
});
