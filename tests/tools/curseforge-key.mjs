#!/usr/bin/env node
// Prints the CurseForge API key saved in a MineShell's Settings (encrypted in its
// database with secret.key beside it), for recording the official API's answers:
//
//   CURSEFORGE_API_KEY="$(node tests/tools/curseforge-key.mjs ~/mineshell-data)" \
//     RECORD_HTTP=1 npx vitest run src/lib/server/mods/curseforge-official-api.test.ts
//
// Not into a file or a terminal: the fixtures record URLs and bodies, never the key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const dir = process.argv[2] || process.env.MINESHELL_DATA;
if (!dir) {
	console.error('usage: curseforge-key.mjs <MineShell data dir>');
	process.exit(2);
}
const db = new Database(path.join(dir, 'mineshell.db'), { readonly: true });
const row = /** @type {{ value: string } | undefined} */ (db.prepare("select value from settings where key = 'curseforge.api_key_enc'").get());
if (!row) {
	console.error(`No CurseForge key saved in ${dir}.`);
	process.exit(1);
}
const secret = Buffer.from(fs.readFileSync(path.join(dir, 'secret.key'), 'utf8').trim(), 'base64');
const [iv, tag, data] = row.value.split(':').map((p) => Buffer.from(p, 'base64'));
const decipher = crypto.createDecipheriv('aes-256-gcm', secret, iv);
decipher.setAuthTag(tag);
process.stdout.write(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
