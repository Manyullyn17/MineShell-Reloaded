#!/usr/bin/env node
/**
 * Checks a server's snapshots on disk, reading only: every file a snapshot's
 * hashes.json records is there with that size and SHA-256, files without a
 * record are listed, and the live world shares no file with any snapshot.
 * Prints each snapshot's linked files and the space all of them take (each
 * file counted once, as `du` does). For trying shared snapshot files on a real
 * install: after a snapshot is deleted, the others must still check out.
 *
 *   node tests/tools/snapshot-check.mjs <server folder>
 *
 * A file linked into several snapshots is hashed once. Exits 1 on a mismatch.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const server = process.argv[2];
if (!server) throw new Error('Usage: snapshot-check.mjs <server folder>');
const snapshots = path.join(server, '.mineshell', 'snapshots');

/** Every file under dir, as paths relative to it. */
function walk(dir, rel = '') {
	const out = [];
	for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
		const p = path.join(rel, entry.name);
		if (entry.isDirectory()) out.push(...walk(dir, p));
		else if (entry.isFile()) out.push(p);
	}
	return out;
}

const hashed = new Map();
function sha256(file, ino) {
	if (!hashed.has(ino)) hashed.set(ino, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
	return hashed.get(ino);
}

const seen = new Set();
const snapshotInodes = new Set();
let total = 0;
let bad = 0;
for (const id of fs.readdirSync(snapshots).sort()) {
	const dir = path.join(snapshots, id);
	if (!fs.statSync(dir).isDirectory()) continue;
	const hashesFile = path.join(dir, 'hashes.json');
	const records = fs.existsSync(hashesFile) ? JSON.parse(fs.readFileSync(hashesFile, 'utf8')).files : null;
	let files = 0;
	let linked = 0;
	let checked = 0;
	const unrecorded = [];
	for (const rel of walk(dir)) {
		const file = path.join(dir, rel);
		const stat = fs.statSync(file);
		files++;
		if (stat.nlink > 1) linked++;
		snapshotInodes.add(stat.ino);
		if (!seen.has(stat.ino)) {
			seen.add(stat.ino);
			total += stat.blocks * 512;
		}
		if (!records || rel === 'hashes.json' || rel === 'manifest.json') continue;
		const record = records[rel];
		if (!record) {
			unrecorded.push(rel);
			continue;
		}
		checked++;
		if (stat.size !== record[0]) {
			console.log(`  ${id}/${rel}: size ${stat.size}, recorded ${record[0]}`);
			bad++;
		} else if (sha256(file, stat.ino) !== record[2]) {
			console.log(`  ${id}/${rel}: content differs from its recorded hash`);
			bad++;
		}
	}
	const missing = records ? Object.keys(records).filter((rel) => !fs.existsSync(path.join(dir, rel))) : [];
	for (const rel of missing) console.log(`  ${id}/${rel}: recorded, missing`);
	bad += missing.length;
	console.log(
		`${id}: ${files} files, ${linked} linked, ` +
			(records ? `${checked} checked against hashes.json` : 'no hashes.json (made before shared files)') +
			(unrecorded.length ? `, ${unrecorded.length} without a record: ${unrecorded.slice(0, 5).join(', ')}` : '')
	);
}

const properties = fs.readFileSync(path.join(server, 'server.properties'), 'utf8');
const world = properties.match(/^level-name=(.*)$/m)?.[1].trim() || 'world';
const shared = fs.existsSync(path.join(server, world)) ? walk(path.join(server, world)).filter((rel) => snapshotInodes.has(fs.statSync(path.join(server, world, rel)).ino)) : [];
console.log(`Live world (${world}): ${shared.length ? `${shared.length} files shared with a snapshot: ${shared.slice(0, 5).join(', ')}` : 'shares no file with a snapshot'}`);
bad += shared.length;
console.log(`All snapshots: ${(total / 1024 ** 3).toFixed(2)} GB on disk, each file counted once`);
console.log(bad ? `${bad} problems` : 'All good');
process.exit(bad ? 1 : 0);
