#!/usr/bin/env node
/**
 * Gives the owner account a new random password, for when it is forgotten,
 * and signs the owner out everywhere. Run it as the user MineShell runs as:
 * whoever can read MineShell's database can do anything to it anyway, which
 * is why this needs no other proof.
 *
 *   npm run reset-password
 *   (an installed release: MINESHELL_ENV_FILE=~/.config/mineshell/mineshell.env node scripts/reset-password.mjs)
 */
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { hashPassword } from '../src/lib/server/passwordhash.js';

/**
 * Minimal .env reader, as in setup.mjs and doctor.mjs: these scripts run as
 * plain Node, and without it would quietly use the default data directory.
 */
function loadDotenv(dir = process.cwd()) {
	// MINESHELL_ENV_FILE: an installed MineShell's config (the installer sets it).
	const file = process.env.MINESHELL_ENV_FILE || path.join(dir, '.env');
	let text;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		return;
	}
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
			(value.startsWith("'") && value.endsWith("'") && value.length > 1)
		) {
			value = value.slice(1, -1);
		}
		// A real environment variable wins over the file, as with Vite.
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

function fail(message) {
	console.error(message);
	process.exit(1);
}

loadDotenv();
const DATA_DIR = path.resolve(
	process.env.MINESHELL_DATA ||
		path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'mineshell')
);
const DB_PATH = path.join(DATA_DIR, 'mineshell.db');
if (!existsSync(DB_PATH)) fail(`No MineShell database at ${DB_PATH}. Is MINESHELL_DATA (or MINESHELL_ENV_FILE) right?`);

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()) {
	fail('This database is from before accounts. Start MineShell once (it updates the database), then run this again.');
}
const owner = db.prepare('SELECT id, username FROM users WHERE is_owner = 1').get();
if (!owner) fail('MineShell has no account yet: open it in a browser and pick a password there.');

const password = crypto.randomBytes(18).toString('base64url');
// A database from before forced changes (migration 0021) has no such column.
const forced = db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'must_change_password'").get();
db.transaction(() => {
	db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(password), Date.now(), owner.id);
	if (forced) db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(owner.id);
	db.prepare('DELETE FROM sessions WHERE user_id = ?').run(owner.id);
})();
db.close();

console.log(`New password for ${owner.username} (the owner account, ${DATA_DIR}):

    ${password}

Every session of ${owner.username} was signed out. Sign in with this password; MineShell then asks
you to pick your own.`);
