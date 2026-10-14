#!/usr/bin/env node
// Item names and pictures across vanilla versions and real servers: see README.md.
// Loads MineShell's own code through Vite (the repo's config: #lib, $app/env,
// import.meta.glob), against a data folder of its own, never the real one.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'mineshell-itemicons');

// Client jars and minecraft-data lists are kept between runs; the database is throwaway.
process.env.MINESHELL_DATA ||= path.join(cache, 'data');
const data = path.resolve(process.env.MINESHELL_DATA);
for (const real of [path.join(os.homedir(), '.local/share/mineshell'), path.join(os.homedir(), 'mineshell-data')]) {
	if (data === real || data.startsWith(real + path.sep)) {
		console.error(`Refusing to run on ${data}: that is a real MineShell data folder.`);
		process.exit(1);
	}
}
if (fs.existsSync(path.join(data, 'instances')) && fs.readdirSync(path.join(data, 'instances')).length) {
	console.error(`Refusing to run on ${data}: it has servers in it.`);
	process.exit(1);
}
fs.mkdirSync(data, { recursive: true });
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
// SvelteKit writes this run's output to .svelte-kit-<hash of the data folder> (vite.config.ts); of no use afterwards.
const outDir = path.join(repo, `.svelte-kit-${createHash('sha256').update(data).digest('hex').slice(0, 8)}`);
let code = 0;
try {
	const { main } = await server.ssrLoadModule('/tests/itemicons/check.ts');
	code = await main(process.argv.slice(2), { repo, cache });
} catch (e) {
	console.error(e);
	code = 1;
} finally {
	await server.close();
	fs.rmSync(outDir, { recursive: true, force: true });
}
process.exit(code);
