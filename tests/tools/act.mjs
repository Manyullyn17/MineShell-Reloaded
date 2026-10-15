#!/usr/bin/env node
/**
 * Posts to a form action of a running (throwaway, MINESHELL_AUTH=off) dev
 * server the way the page's enhanced form does, and prints the answer with
 * its data decoded: for driving MineShell from a script while trying things.
 *
 *   node tests/tools/act.mjs <page url>?/<action> [field=value ...]
 *   node tests/tools/act.mjs 'http://127.0.0.1:5199/instances/new?/loader' name=Test minecraftVersion=1.21.1 modloader=fabric
 *
 * A field given twice is sent twice (checkbox groups). `field=@path` sends
 * the file at path. Exits 1 when the action failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const devalue = require('devalue');

const [url, ...fields] = process.argv.slice(2);
if (!url || !url.includes('?/')) {
	console.error('Usage: node tests/tools/act.mjs <page url>?/<action> [field=value ...]');
	process.exit(1);
}
const body = new FormData();
for (const field of fields) {
	const at = field.indexOf('=');
	if (at < 0) throw new Error(`"${field}" is not field=value.`);
	const name = field.slice(0, at);
	const value = field.slice(at + 1);
	if (value.startsWith('@')) {
		const file = value.slice(1);
		body.append(name, new Blob([fs.readFileSync(file)]), path.basename(file));
	} else body.append(name, value);
}
const origin = new URL(url).origin;
const response = await fetch(url, { method: 'POST', body, headers: { origin, 'x-sveltekit-action': 'true' } });
const text = await response.text();
let result;
try {
	result = JSON.parse(text);
} catch {
	console.log(`${response.status}: ${text.slice(0, 500)}`);
	process.exit(1);
}
if (typeof result.data === 'string') result.data = devalue.parse(result.data);
console.log(JSON.stringify(result, null, 1));
process.exit(result.type === 'failure' || result.type === 'error' ? 1 : 0);
