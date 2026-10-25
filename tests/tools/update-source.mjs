#!/usr/bin/env node
/**
 * A stand-in for GitHub's release list, for trying Settings > Updates on a
 * throwaway install (scripts/install.sh with MINESHELL_ARCHIVE and throwaway
 * MINESHELL_HOME/CONFIG/SERVICE/DATA/UNIT_PREFIX/PORT): serves a folder of
 * release archives and writes an update check naming them into the install's
 * database, with automatic checks turned off so GitHub's answer does not
 * replace it. Never point this at real data.
 *
 *   node tests/tools/update-source.mjs <data dir> <archive folder> [port]
 *
 * Every mineshell-<version>.tar.gz with its .sha256 in the folder becomes a
 * release, the newest the latest. Runs until stopped (Ctrl-C). An install
 * from 0.15 on refuses downloads from 127.0.0.1 until it is allowed
 * (MineShell settings > System, or the Activity prompt).
 *
 * The server keeps connections alive: Node's built-in fetch (undici 7) can
 * crash the whole process on a full response from a server that closes the
 * connection after it, as Python's http.server does (docs/notes/runtime.md).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const [dataDir, folder, portArg] = process.argv.slice(2);
if (!dataDir || !folder) {
	console.error('Usage: node tests/tools/update-source.mjs <data dir> <archive folder> [port]');
	process.exit(1);
}
const port = Number(portArg ?? 8766);
const base = `http://127.0.0.1:${port}`;

const compare = (a, b) => {
	const [x, y] = [a, b].map((v) => v.split(/[.-]/).slice(0, 3).map(Number));
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
};
const versions = fs
	.readdirSync(folder)
	.map((f) => /^mineshell-(\d+\.\d+\.\d+)\.tar\.gz$/.exec(f)?.[1])
	.filter((v) => v && fs.existsSync(path.join(folder, `mineshell-${v}.tar.gz.sha256`)))
	.sort(compare)
	.reverse();
if (!versions.length) {
	console.error(`No mineshell-<version>.tar.gz with its .sha256 in ${folder}.`);
	process.exit(1);
}
const releases = versions.map((version) => ({
	tag: `v${version}`,
	version,
	name: `MineShell v${version}`,
	notes: '## Fixed\n\n- A local test release',
	url: base,
	publishedAt: fs.statSync(path.join(folder, `mineshell-${version}.tar.gz`)).mtime.toISOString(),
	archiveUrl: `${base}/mineshell-${version}.tar.gz`,
	checksumUrl: `${base}/mineshell-${version}.tar.gz.sha256`
}));

const db = new Database(path.join(dataDir, 'mineshell.db'));
const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
set.run('update.autoCheck', 'false');
set.run('update.check', JSON.stringify({ checkedAt: Date.now(), latest: releases[0], releases, error: null }));
db.close();
console.log(`Update check written: latest ${versions[0]}, releases ${versions.join(', ')}.`);

http
	.createServer((req, res) => {
		const file = path.join(folder, path.basename(decodeURIComponent(new URL(req.url ?? '/', base).pathname)));
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
			res.writeHead(404).end();
			return;
		}
		console.log(`${req.method} ${req.url}`);
		res.writeHead(200, { 'content-length': fs.statSync(file).size });
		if (req.method === 'HEAD') res.end();
		else fs.createReadStream(file).pipe(res);
	})
	.listen(port, '127.0.0.1', () => console.log(`Serving ${folder} on ${base}`));
