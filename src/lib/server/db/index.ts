import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { DB_PATH, ensureDirs } from '../config';
import { runMigrations } from './migrate';

ensureDirs();

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

runMigrations(sqlite);

export const db = drizzle(sqlite, { schema });
export const raw = sqlite;
export { schema };
