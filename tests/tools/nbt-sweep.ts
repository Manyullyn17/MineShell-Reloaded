/**
 * Reads every .dat, .dat_old, .nbt, .schematic, .schem and .litematic file under the given
 * server folders, read-only, and says what each is: gzipped, zlib or plain NBT, with or
 * without bytes after the root tag, or not NBT (and why). For the NBT editor's "is it NBT?"
 * check; with --roundtrip, also writes each one back in memory and compares the bytes.
 *
 *   npx tsx tests/tools/nbt-sweep.ts [--roundtrip] ~/mineshell-data/instances/*
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseNbt, writeNbt } from '../../src/lib/server/nbt.ts';

const args = process.argv.slice(2);
const roundtrip = args.includes('--roundtrip');
const roots = args.filter((a) => !a.startsWith('--'));
const NAMES = /\.(dat|dat_old|nbt|schematic|schem|litematic)$/i;

const files: string[] = [];
function walk(dir: string) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === '.mineshell') continue;
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walk(full);
		else if (e.isFile() && NAMES.test(e.name)) files.push(full);
	}
}
for (const root of roots) walk(root);

/** What the first bytes say: gzip, zlib (78 01/5e/9c/da) or anything else. */
function wrapping(data: Buffer): 'gzip' | 'zlib' | 'plain' {
	if (data[0] === 0x1f && data[1] === 0x8b) return 'gzip';
	if (data[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(data[1])) return 'zlib';
	return 'plain';
}

const results = new Map<string, string[]>();
const note = (kind: string, file: string) => results.set(kind, [...(results.get(kind) ?? []), file]);
let mismatches = 0;
for (const file of files) {
	const data = fs.readFileSync(file);
	const wrap = wrapping(data);
	const ext = path.extname(file).toLowerCase();
	if (!data.length) {
		note(`${ext} empty`, file);
		continue;
	}
	try {
		const raw = wrap === 'gzip' ? zlib.gunzipSync(data) : wrap === 'zlib' ? zlib.inflateSync(data) : data;
		const parsed = parseNbt(wrap === 'zlib' ? raw : data);
		const used = writeNbt({ ...parsed, gzipped: false }).length;
		const trailing = raw.length - used;
		note(`${ext} ${wrap} NBT${trailing ? `, ${trailing > 0 ? 'bytes after the root' : 'shorter than written'}` : ''}${parsed.name ? ', named root' : ''}`, file);
		if (roundtrip && wrap !== 'zlib' && !trailing) {
			const again = writeNbt(parsed);
			const same = wrap === 'gzip' ? zlib.gunzipSync(again).equals(raw) : again.equals(data);
			if (!same) {
				mismatches++;
				note(`${ext} does not write back the same`, file);
			}
		}
	} catch (err) {
		note(`${ext} ${wrap}, not NBT: ${(err as Error).message.slice(0, 60)}`, file);
	}
}

console.log(`${files.length} files`);
for (const [kind, list] of [...results].sort((a, b) => b[1].length - a[1].length)) {
	console.log(`  ${list.length} × ${kind}\n      e.g. ${list.slice(0, 3).join('\n           ')}`);
}
if (roundtrip) console.log(`written back differently: ${mismatches}`);
