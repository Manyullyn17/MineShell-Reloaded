#!/usr/bin/env node
/**
 * Runs a few lines against MineShell's own code and prints what they return: a
 * quick answer to "what does this function do with that?" without a test file
 * (Vitest keeps console output to itself) or a dev server.
 *
 *   node tests/tools/lib.mjs '<code>' [--data dir]
 *   node tests/tools/lib.mjs --file probe.ts [--data dir]
 *
 * The code is the body of an async function: `await import('#lib/server/x.js')`
 * works, console.log prints, and what it returns is printed (util.inspect). It
 * loads through Vite with the repo's config (#lib, $app/env), as
 * tests/itemicons/check.mjs does, on a data folder of its own: a new temporary
 * one, removed afterwards, unless --data names one (never a real MineShell's).
 * Units are named mstest@; code that starts servers or calls systemd does so
 * for real.
 *
 *   node tests/tools/lib.mjs "const { attachment } = await import('#lib/server/files.js'); return attachment('Größe.zip')"
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
/** @param {string} name */
const option = (name) => {
	const at = args.indexOf(name);
	return at < 0 ? null : args.splice(at, 2)[1];
};
const file = option('--file');
const given = option('--data');
const code = file ? fs.readFileSync(file, 'utf8') : args[0];
if (!code) {
	console.error("Usage: node tests/tools/lib.mjs '<code>' [--data dir]  |  --file probe.ts [--data dir]");
	process.exit(1);
}

const data = path.resolve(given ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lib-')));
for (const real of [path.join(os.homedir(), '.local/share/mineshell'), path.join(os.homedir(), 'mineshell-data')]) {
	if (data === real || data.startsWith(real + path.sep)) {
		console.error(`Refusing to run on ${data}: that is a real MineShell data folder.`);
		process.exit(1);
	}
}
process.env.MINESHELL_DATA = data;
process.env.MINESHELL_AUTH = 'off';
process.env.MINESHELL_UNIT_PREFIX = 'mstest';

const { createServer } = await import(path.join(repo, 'node_modules/vite/dist/node/index.js'));
const server = await createServer({
	root: repo,
	configFile: path.join(repo, 'vite.config.ts'),
	server: { middlewareMode: true, hmr: false, watch: null, ws: false },
	appType: 'custom',
	logLevel: 'error',
	optimizeDeps: { noDiscovery: true, include: [] }
});
// SvelteKit writes this run's output to .svelte-kit-<hash of the data folder> (vite.config.ts);
// the code goes there too, inside the repo so #lib resolves, and both are removed afterwards.
const outDir = path.join(repo, `.svelte-kit-${createHash('sha256').update(data).digest('hex').slice(0, 8)}`);
fs.mkdirSync(outDir, { recursive: true });
const entry = path.join(outDir, `lib-run-${process.pid}.ts`);
fs.writeFileSync(entry, `export default async function () {\n${code}\n}\n`);
let exit = 0;
try {
	const { default: run } = await server.ssrLoadModule(entry);
	const result = await run();
	if (result !== undefined) console.log(inspect(result, { depth: 6, colors: process.stdout.isTTY, maxArrayLength: 200 }));
} catch (e) {
	console.error(e);
	exit = 1;
} finally {
	await server.close();
	fs.rmSync(outDir, { recursive: true, force: true });
	if (!given) fs.rmSync(data, { recursive: true, force: true });
}
process.exit(exit);
