#!/usr/bin/env node
/**
 * How does Minecraft itself treat a file? Runs a vanilla server of one version on
 * a scratch folder holding the files given, lets it start (until "Done (", then
 * `stop`), and shows what it changed: a diff of each text file it rewrote and the
 * files it added. For questions about the formats MineShell writes for the game:
 * how server.properties is read and written back (escapes, Latin-1 up to 1.12),
 * ops.json, whitelist.json, what a version adds or renames.
 *
 *   node tests/tools/mc-probe.mjs <version> [options]
 *     --file <path>=<text>  put this file in the folder first (repeatable; \n in the
 *                           text is a line break). Without a server.properties, one
 *                           with a free port and online-mode=false is written
 *     --from <dir>          copy this folder's files in first (--file goes on top)
 *     --java <path>         this java (default: the version's own major from
 *                           /usr/lib/jvm, MineShell's downloads, then the newest found)
 *     --timeout <s>         stop waiting for "Done (" after this long (default 120)
 *     --keep <dir>          run in this folder and keep it (default: a temporary one,
 *                           removed afterwards)
 *     --all                 also list what changed under the world, logs, libraries
 *                           and versions folders
 *     --command <cmd>       a console command once started, before stop (repeatable;
 *                           `op Steve` shows how ops.json is written)
 *
 * Server jars come from Mojang (the version manifest) and are cached under
 * ~/.cache/mineshell-mc-probe. Nothing of MineShell's is touched; no unit is used.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
/** @param {string} name */
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const version = args[0];
if (!version || version.startsWith('--')) {
	console.error('Usage: node tests/tools/mc-probe.mjs <version> [--file path=text]... [--from dir] [--java path] [--timeout s] [--keep dir] [--all] [--command cmd]...');
	process.exit(1);
}
const timeout = Number(all('--timeout')[0] ?? 120) * 1000;
const showAll = args.includes('--all');
const commands = all('--command');
const cache = path.join(os.homedir(), '.cache', 'mineshell-mc-probe');

/** The server jar of `version` and the Java major it wants. */
async function serverJar() {
	const dir = path.join(cache, version);
	const jar = path.join(dir, 'server.jar');
	const metaFile = path.join(dir, 'version.json');
	if (!fs.existsSync(jar)) {
		const manifest = await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json();
		const entry = manifest.versions.find((/** @type {{ id: string }} */ v) => v.id === version);
		if (!entry) throw new Error(`Mojang has no version ${version}.`);
		const meta = await (await fetch(entry.url)).json();
		if (!meta.downloads?.server) throw new Error(`${version} has no server download.`);
		fs.mkdirSync(dir, { recursive: true });
		console.log(`Downloading the ${version} server...`);
		const bytes = Buffer.from(await (await fetch(meta.downloads.server.url)).arrayBuffer());
		if (crypto.createHash('sha1').update(bytes).digest('hex') !== meta.downloads.server.sha1) throw new Error('The download does not match its checksum.');
		fs.writeFileSync(jar, bytes);
		fs.writeFileSync(metaFile, JSON.stringify({ java: meta.javaVersion?.majorVersion ?? 8 }));
	}
	return { jar, java: JSON.parse(fs.readFileSync(metaFile, 'utf8')).java };
}

/** A java binary for `major`: that major if there is one, else the newest. @param {number} major */
function findJava(major) {
	if (all('--java')[0]) return all('--java')[0];
	const roots = ['/usr/lib/jvm', path.join(os.homedir(), '.local/share/mineshell/java'), path.join(os.homedir(), 'mineshell-data/java')];
	/** @type {{ major: number, bin: string }[]} */
	const found = [];
	for (const root of roots) {
		for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
			const bin = path.join(root, name, 'bin', 'java');
			const release = path.join(root, name, 'release');
			if (!fs.existsSync(bin) || !fs.existsSync(release)) continue;
			const v = /JAVA_VERSION="(\d+)(?:\.(\d+))?/.exec(fs.readFileSync(release, 'utf8'));
			if (v) found.push({ major: v[1] === '1' ? Number(v[2]) : Number(v[1]), bin: fs.realpathSync(bin) });
		}
	}
	const exact = found.find((j) => j.major === major);
	if (exact) return exact.bin;
	const newest = found.sort((a, b) => b.major - a.major)[0];
	if (!newest) throw new Error('No Java found: pass --java.');
	console.log(`No Java ${major}; using Java ${newest.major}.`);
	return newest.bin;
}

/** A free TCP port. @returns {Promise<number>} */
const freePort = () =>
	new Promise((resolve) => {
		const server = net.createServer().listen(0, () => {
			const { port } = /** @type {net.AddressInfo} */ (server.address());
			server.close(() => resolve(port));
		});
	});

/** Every file under `dir` and a hash of it. @param {string} dir */
function snapshot(dir) {
	/** @type {Map<string, string>} */
	const files = new Map();
	for (const rel of /** @type {string[]} */ (fs.readdirSync(dir, { recursive: true }))) {
		const abs = path.join(dir, rel);
		if (fs.statSync(abs).isFile()) files.set(rel, crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex'));
	}
	return files;
}

const { jar, java: major } = await serverJar();
const javaBin = findJava(major);
const keep = all('--keep')[0];
const dir = keep ? path.resolve(keep) : fs.mkdtempSync(path.join(os.tmpdir(), 'mc-probe-'));
const before = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-probe-before-')), 'files');
try {
	fs.mkdirSync(dir, { recursive: true });
	const from = all('--from')[0];
	if (from) fs.cpSync(from, dir, { recursive: true });
	for (const spec of all('--file')) {
		const at = spec.indexOf('=');
		const file = path.join(dir, spec.slice(0, at));
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, spec.slice(at + 1).replace(/\\n/g, '\n'));
	}
	const props = path.join(dir, 'server.properties');
	if (!fs.existsSync(props)) fs.writeFileSync(props, `server-port=${await freePort()}\nonline-mode=false\n`);
	fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
	fs.cpSync(dir, before, { recursive: true });
	const start = snapshot(dir);

	console.log(`Minecraft ${version} on ${javaBin} in ${dir}`);
	const server = spawn(javaBin, ['-Xmx1G', '-jar', jar, 'nogui'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
	let log = '';
	const done = new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeout);
		const read = (/** @type {Buffer} */ chunk) => {
			log += chunk;
			if (/Done \(/.test(log)) {
				clearTimeout(timer);
				resolve(true);
			}
		};
		server.stdout.on('data', read);
		server.stderr.on('data', read);
		server.on('exit', () => resolve(false));
	});
	const exited = new Promise((resolve) => server.on('exit', resolve));
	const started = await done;
	if (started) {
		for (const command of commands) {
			const at = log.length;
			server.stdin.write(`${command}\n`);
			await new Promise((r) => setTimeout(r, 1500));
			console.log(`> ${command}\n${log.slice(at).trim().replace(/^/gm, '  ')}`);
		}
		server.stdin.write('stop\n');
	} else console.log(`It did not reach "Done (" (last lines below).`);
	const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 60_000))]);
	if (code === 'still running') server.kill('SIGKILL');
	if (!started) console.log(log.trim().split('\n').slice(-15).join('\n'));

	const after = snapshot(dir);
	const skip = (/** @type {string} */ rel) => !showAll && /^(world[^/]*|logs|libraries|versions|crash-reports)\//.test(rel);
	const changed = [...after.keys()].filter((rel) => start.has(rel) && start.get(rel) !== after.get(rel) && !skip(rel));
	const added = [...after.keys()].filter((rel) => !start.has(rel) && !skip(rel));
	const removed = [...start.keys()].filter((rel) => !after.has(rel) && !skip(rel));
	for (const rel of changed.sort()) {
		console.log(`\nChanged ${rel}:`);
		const diff = spawnSync('diff', ['-u', '--label', `${rel} (given)`, '--label', `${rel} (after)`, path.join(before, rel), path.join(dir, rel)], { encoding: 'utf8' });
		console.log(diff.stdout.trim());
	}
	for (const rel of added.sort()) {
		// Small text files in full (ops.json after `op`), the rest by name.
		const text = fs.statSync(path.join(dir, rel)).size <= 2048 ? fs.readFileSync(path.join(dir, rel), 'utf8') : null;
		const shown = text !== null && !text.includes('\0') ? `\n${text.trim().replace(/^/gm, '    ')}` : '';
		console.log(`\nAdded ${rel}${shown}`);
	}
	if (removed.length) console.log(`\nRemoved:\n  ${removed.sort().join('\n  ')}`);
	if (!changed.length && !added.length && !removed.length) console.log('\nNothing changed outside the world, logs and libraries.');
} finally {
	fs.rmSync(path.dirname(before), { recursive: true, force: true });
	if (!keep) fs.rmSync(dir, { recursive: true, force: true });
}
