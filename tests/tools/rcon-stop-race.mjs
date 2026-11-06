#!/usr/bin/env node
/**
 * Does polling RCON through a shutdown hang the server? A command that reaches a stopping
 * Minecraft waits for the server thread, which waits for that RCON thread to end: "attempting
 * force stop", for good (rcon.ts). Boots vanilla repeatedly, polls `list` through MineShell's
 * own rconExec as fast as it answers, sends `stop` the same way, and counts the runs that hang.
 * The jar comes from mc-probe's cache: run `mc-probe.mjs <version>` once first.
 *
 *   node --experimental-transform-types tests/tools/rcon-stop-race.mjs [--runs 8] [--version 1.21.1] [--rcon <rcon.ts>]
 *
 * --rcon takes another copy of rcon.ts (`git show <rev>:src/lib/server/rcon.ts > old.ts`), to
 * see an older one hang. Nothing of MineShell's is touched; no unit is used.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const option = (name, fallback) => {
	const at = args.indexOf(name);
	return at < 0 ? fallback : args[at + 1];
};
const runs = Number(option('--runs', '8'));
const version = option('--version', '1.21.1');
const module = path.resolve(option('--rcon', new URL('../../src/lib/server/rcon.ts', import.meta.url).pathname));
const { rconExec } = await import(module);

const jar = path.join(os.homedir(), '.cache/mineshell-mc-probe', version, 'server.jar');
if (!fs.existsSync(jar)) throw new Error(`No ${jar}: run tests/tools/mc-probe.mjs ${version} once first.`);
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {number} n */
async function run(n) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcon-stop-race-'));
	const port = 26990 + n;
	fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
	fs.writeFileSync(path.join(dir, 'server.properties'), `online-mode=false\nserver-port=${25990 + n}\nenable-rcon=true\nrcon.port=${port}\nrcon.password=race\n`);
	const java = spawn('java', ['-Xmx1G', '-jar', jar, 'nogui'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
	let log = '';
	let exited = false;
	java.stdout.on('data', (d) => (log += d));
	java.on('exit', () => (exited = true));
	try {
		for (let i = 0; i < 240 && !log.includes('RCON running'); i++) await sleep(250);
		if (!log.includes('RCON running')) throw new Error(`Run ${n} did not start.`);
		const target = { port, password: 'race', timeoutMs: 1000 };
		let polling = true;
		const poll = (async () => {
			while (polling) await rconExec(target, ['list']).catch(() => sleep(1));
		})();
		await sleep(200);
		await rconExec(target, ['stop']);
		for (let i = 0; i < 40 && !exited; i++) await sleep(250);
		polling = false;
		await poll;
		return !exited;
	} finally {
		java.kill('SIGKILL');
		await sleep(200);
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

let hung = 0;
for (let n = 1; n <= runs; n++) {
	const stuck = await run(n);
	hung += stuck ? 1 : 0;
	console.log(`run ${n}: ${stuck ? 'HUNG' : 'stopped'}`);
}
console.log(`${hung} of ${runs} hung (${path.relative(process.cwd(), module)})`);
process.exit(0);
