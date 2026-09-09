import type BetterSqlite3 from 'better-sqlite3';

/**
 * The .sql files are inlined at build time, so migrations work identically in
 * `vite dev` and in the bundled adapter-node output without hunting for a path.
 * Add a new file as migrations/000N_description.sql and it applies on next boot.
 */
const files = import.meta.glob('/migrations/*.sql', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

export function runMigrations(sqlite: BetterSqlite3.Database): void {
	sqlite.exec(
		`CREATE TABLE IF NOT EXISTS _migrations (
       name TEXT PRIMARY KEY NOT NULL,
       applied_at INTEGER NOT NULL
     )`
	);

	const applied = new Set(
		sqlite
			.prepare('SELECT name FROM _migrations')
			.all()
			.map((r) => (r as { name: string }).name)
	);

	const pending = Object.keys(files)
		.sort()
		.map((key) => ({ name: key.split('/').pop() as string, sql: files[key] }))
		.filter((m) => !applied.has(m.name));

	if (pending.length === 0) return;

	const record = sqlite.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
	for (const migration of pending) {
		const apply = sqlite.transaction(() => {
			sqlite.exec(migration.sql);
			record.run(migration.name, Date.now());
		});
		apply();
		console.log(`[mineshell] applied migration ${migration.name}`);
	}
}
