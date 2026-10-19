#!/usr/bin/env node
/**
 * Screenshots for the README (README.md here): a throwaway MineShell with the
 * placeholder world from scenes.mjs, servers "running" on fakeserver.mjs, and
 * every shot in shots.mjs written to docs/screenshots/.
 *
 *   npm run screenshots                     every shot
 *   npm run screenshots -- overview mods    only these
 *   npm run screenshots -- --keep           leave it running to look around (http://localhost:5198)
 *   npm run screenshots -- --serve          only the world and its running servers, no pictures (kept)
 *   npm run screenshots -- --cleanup        end a --keep or --serve run
 *
 * Its own data dir, port and unit prefix (msshot), so it never meets real
 * servers or another throwaway dev server. The template unit it installs and
 * the servers' units are removed afterwards.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { scenes, offlineUuid } from './scenes.mjs';
import { shots, visits } from './shots.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const DATA = '/tmp/ms-shots';
const PORT = 5198;
// A unit prefix of its own each run: the journal outlives units, and the
// console reads a server's back to its (seeded, weeks old) creation, so a
// reused name showed every earlier run's lines and counted them.
const PREFIX_BASE = 'msshot';
const PREFIX = `${PREFIX_BASE}${crypto.randomBytes(2).toString('hex')}`;
const BASE = `http://localhost:${PORT}`;
const OUT = path.join(REPO, 'docs/screenshots');
const UNIT_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd/user');

const args = process.argv.slice(2);
const serve = args.includes('--serve');
const keep = serve || args.includes('--keep');
const only = args.filter((a) => !a.startsWith('--'));

/** @param {string} cmd @param {string[]} cmdArgs @param {Record<string, string>} [env] */
const sh = (cmd, cmdArgs, env = {}) => {
	const res = spawnSync(cmd, cmdArgs, { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env } });
	return { code: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
};
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup() {
	sh('systemctl', ['--user', 'stop', `${PREFIX_BASE}*@*`]);
	for (const name of fs.existsSync(UNIT_DIR) ? fs.readdirSync(UNIT_DIR) : []) {
		if (new RegExp(`^(app-)?${PREFIX_BASE}[0-9a-f]*(@|\\.slice)`).test(name)) fs.rmSync(path.join(UNIT_DIR, name), { recursive: true, force: true });
	}
	sh('systemctl', ['--user', 'daemon-reload']);
	sh('systemctl', ['--user', 'reset-failed', `${PREFIX_BASE}*@*`]);
	sh('bash', ['tests/tools/devserver.sh', 'stop', String(PORT)]);
}

if (args.includes('--cleanup')) {
	cleanup();
	console.log('Stopped and removed.');
	process.exit(0);
}

/**
 * A form action, posted the way an enhanced form does (tests/tools/act.mjs).
 * @param {string} page @param {string} action @param {Record<string, string>} [fields]
 */
async function act(page, action, fields = {}) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.append(k, v);
	const res = await fetch(`${BASE}${page}?/${action}`, { method: 'POST', body, headers: { origin: BASE, 'x-sveltekit-action': 'true' } });
	const result = await res.json();
	if (result.type !== 'success') throw new Error(`${page}?/${action}: ${JSON.stringify(result)}`);
}

/**
 * For scenes that take real names and icons from a mod platform; tries three times.
 * @param {string} url @returns {Promise<any>}
 */
async function fetchJson(url) {
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(url, { headers: { 'User-Agent': 'MineShell screenshots (github.com/Manyullyn17/MineShell-Reloaded)' } });
		if (res.ok) return res.json();
		if (attempt === 3 || res.status < 500) throw new Error(`${url} returned ${res.status}`);
		await sleep(2000 * attempt);
	}
}

// ---------------------------------------------------------------- start ---

cleanup();
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
// Uptime: the fake servers start a minute before the pictures, so MineShell is
// told they started earlier. Its systemctl, and only its, goes through this
// wrapper, which moves a screenshot unit's start time (ActiveEnterTimestampMonotonic)
// back by the seconds in $DATA/uptime/<id>; the run that MineShell matches it
// with is moved back the same way after the start (below).
const realSystemctl = sh('bash', ['-c', 'command -v systemctl']).out.trim();
fs.mkdirSync(path.join(DATA, 'bin'));
fs.mkdirSync(path.join(DATA, 'uptime'));
fs.writeFileSync(
	path.join(DATA, 'bin/systemctl'),
	`#!/bin/bash
# Screenshot runs only (tests/tools/screenshots/run.mjs): earlier start times for ${PREFIX}@ units.
for a in "$@"; do case "$a" in ${PREFIX}@*.service) id="\${a#${PREFIX}@}"; id="\${id%.service}";; esac; done
f="${DATA}/uptime/\${id:-}"
if [[ " $* " == *" show "* && -n "\${id:-}" && -f "$f" ]]; then
	"${realSystemctl}" "$@" | awk -v s="$(( $(cat "$f") * 1000000 ))" -F= 'BEGIN { OFS = "=" } $1 == "ActiveEnterTimestampMonotonic" && $2 > 0 { $2 = $2 - s } { print }'
	exit "\${PIPESTATUS[0]}"
fi
exec "${realSystemctl}" "$@"
`,
	{ mode: 0o755 }
);
const started = sh('bash', ['tests/tools/devserver.sh', 'start', String(PORT), DATA], {
	MINESHELL_UNIT_PREFIX: PREFIX,
	PATH: `${path.join(DATA, 'bin')}:${process.env.PATH}`
});
if (started.code !== 0) throw new Error(started.out);
console.log(started.out.trim());
await fetch(`${BASE}/`); // the first page load runs the migrations and boot

const db = new Database(path.join(DATA, 'mineshell.db'));
const keyFile = path.join(DATA, 'secret.key');
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
/**
 * As lib/server/crypto.ts encrypts the RCON password.
 * @param {string} text
 */
function encrypt(text) {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
	return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join(':');
}

// "Java" for the running servers: fakeserver.mjs on this Node.
const fakeJava = path.join(DATA, 'fake-java');
fs.writeFileSync(fakeJava, `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, 'fakeserver.mjs')}"\n`, { mode: 0o755 });

const now = Date.now();
/** @type {{ id: string; uptimeMinutes: number }[]} */
const toStart = [];
// The fake, as a Java 21 runtime: the running servers' pinned path shows as that.
db.prepare(
	"INSERT INTO java_runtimes (path, major_version, version_string, vendor, manual, last_seen_at) VALUES (?, 21, '21.0.5', 'Eclipse Adoptium', 1, ?)"
).run(fakeJava, Date.now());
let nextPort = 25800;
/**
 * A file of `bytes` that takes no disk space (sparse), so sizes look real. As a
 * jar it is an empty zip: the end record is all a zip reader looks for.
 * @param {string} file @param {number} bytes
 */
function sparseFile(file, bytes, zip = false) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const fd = fs.openSync(file, 'w');
	fs.ftruncateSync(fd, bytes);
	if (zip) fs.writeSync(fd, Buffer.from([0x50, 0x4b, 0x05, 0x06, ...Array(18).fill(0)]), 0, 22, bytes - 22);
	fs.closeSync(fd);
}

/**
 * @typedef {{
 *   db: import('better-sqlite3').Database; dataDir: string; now: number;
 *   server: (o: ServerOptions) => void; tag: (name: string, ids: string[]) => void; sparseFile: typeof sparseFile;
 *   mod: (instanceId: string, m: ModOptions) => void; fetchJson: (url: string) => Promise<any>
 * }} Context
 * @typedef {{ id: string; name: string; minecraft: string; loader: string; loaderVersion?: string; memoryMb?: number;
 *   pinned?: boolean; notes?: string; properties?: Record<string, string>; worldMb?: number;
 *   pack?: { source: string; project: string; version: string; versionName: string; name: string };
 *   running?: { players: string[]; mspt?: number; memoryMb?: number; cpuPercent?: number; chat?: [string, string, number?][]; uptimeMinutes?: number } }} ServerOptions
 * @typedef {{ source: string; slug: string; name: string; summary?: string; projectUrl?: string; iconUrl?: string;
 *   version: string; versionId?: string; fileName: string; size?: number; hash?: string; fromPack?: boolean; enabled?: boolean }} ModOptions
 */

/**
 * What the loader's installer leaves in the folder (jars, libraries) and a few
 * logs, so the disk use is not the world alone. Sparse, apart from the logs,
 * which the Logs tab may open.
 * @param {string} dir @param {string} loader @param {string} minecraft
 */
function installFiles(dir, loader, minecraft) {
	const MB = 1024 * 1024;
	/** @type {[string, number][]} */
	const files =
		loader === 'forge'
			? [
					[`forge-${minecraft}-14.23.5.2860.jar`, 5.1],
					[`minecraft_server.${minecraft}.jar`, 9.6],
					['libraries/org/scala-lang/scala-library/2.11.1/scala-library-2.11.1.jar', 5.5],
					['libraries/org/ow2/asm/asm-all/5.2/asm-all-5.2.jar', 0.3],
					['libraries/net/minecraftforge/forge/libraries.jar', 31]
				]
			: [
					['server.jar', loader === 'vanilla' ? 57 : 0.2],
					[`versions/${minecraft}/server-${minecraft}.jar`, 52],
					['libraries/com/mojang/datafixerupper/datafixerupper.jar', 3.4],
					['libraries/io/netty/netty-all.jar', 4.6],
					['libraries/it/unimi/dsi/fastutil/fastutil.jar', 23],
					['libraries/com/google/guava/guava.jar', 3.1],
					...(/** @type {[string, number][]} */ (loader === 'vanilla' ? [] : [['libraries/net/fabricmc/intermediary.jar', 0.7], ['libraries/net/fabricmc/fabric-loader.jar', 1.4], ['libraries/net/fabricmc/sponge-mixin.jar', 1.5]]))
				];
	for (const [file, mb] of files) sparseFile(path.join(dir, file), Math.round(mb * MB), file.endsWith('.jar'));
	fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
	for (let d = 1; d <= 6; d++) {
		const day = new Date(now - d * 24 * 3600_000).toISOString().slice(0, 10);
		const lines = Array.from({ length: 4000 }, (_, i) => `[05:${String(i % 60).padStart(2, '0')}:00] [Server thread/INFO]: Saved the game`).join('\n');
		fs.writeFileSync(path.join(dir, 'logs', `${day}-1.log.gz`), zlib.gzipSync(lines));
	}
	fs.writeFileSync(path.join(dir, 'logs/latest.log'), '');
}

/** @type {Context} */
const ctx = {
	db,
	dataDir: DATA,
	now,
	fetchJson,
	sparseFile,
	server(o) {
		const dir = path.join(DATA, 'instances', o.id);
		fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
		const port = nextPort++;
		const rconPort = port + 100;
		const password = crypto.randomBytes(12).toString('base64url');
		const properties = {
			'server-port': String(port),
			'enable-rcon': 'true',
			'rcon.port': String(rconPort),
			'rcon.password': password,
			'level-name': 'world',
			motd: o.name,
			'max-players': '10',
			'online-mode': 'true',
			difficulty: 'normal',
			gamemode: 'survival',
			...o.properties
		};
		fs.writeFileSync(path.join(dir, 'server.properties'), Object.entries(properties).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
		if (o.running) {
			const players = o.running.players.map((name) => ({ name, uuid: offlineUuid(name) }));
			fs.writeFileSync(path.join(dir, 'fake-server.json'), JSON.stringify({ version: o.minecraft, ...o.running, players }, null, 1));
			fs.writeFileSync(
				path.join(dir, 'usercache.json'),
				JSON.stringify(players.map((p) => ({ ...p, expiresOn: '2099-01-01 00:00:00 +0000' })))
			);
			toStart.push({ id: o.id, uptimeMinutes: o.running.uptimeMinutes ?? 0 });
		}
		installFiles(dir, o.loader, o.minecraft);
		// A world of about this size, in region files of a few MB each.
		for (let mb = 0, n = 0; mb < (o.worldMb ?? 0); n++) {
			const size = 2 + ((n * 7919) % 9);
			sparseFile(path.join(dir, 'world/region', `r.${(n % 9) - 4}.${Math.floor(n / 9) - 4}.mca`), size * 1024 * 1024);
			mb += size;
		}
		const memory = o.memoryMb ?? 4096;
		db.prepare(
			`INSERT INTO server_instances (id, name, path, minecraft_version, modloader, modloader_version, pack_source, pack_project_id,
				pack_version_id, pack_version_name, pack_name, server_port, rcon_port, rcon_password_enc, memory_max_mb, jvm_args,
				launch_args, java_path, eula_accepted, pinned, notes, update_check, mod_update_check, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '-jar server.jar nogui', ?, 1, ?, ?, 0, 0, ?, ?)`
		).run(
			o.id,
			o.name,
			dir,
			o.minecraft,
			o.loader,
			o.loaderVersion ?? null,
			o.pack?.source ?? null,
			o.pack?.project ?? null,
			o.pack?.version ?? null,
			o.pack?.versionName ?? null,
			o.pack?.name ?? null,
			port,
			rconPort,
			encrypt(password),
			memory,
			`-Xms1G -Xmx${memory}M`,
			o.running ? fakeJava : null,
			o.pinned ? 1 : 0,
			o.notes ?? null,
			now - 40 * 24 * 3600_000,
			now
		);
	},
	tag(name, ids) {
		const id = crypto.randomUUID();
		db.prepare('INSERT INTO server_tags (id, name) VALUES (?, ?)').run(id, name);
		for (const instance of ids) db.prepare('INSERT INTO instance_tags (instance_id, tag_id) VALUES (?, ?)').run(instance, id);
	},
	mod(instanceId, m) {
		db.prepare(
			`INSERT INTO mods (source, slug, name, summary, project_url, icon_url) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (source, slug) DO NOTHING`
		).run(m.source, m.slug, m.name, m.summary ?? null, m.projectUrl ?? null, m.iconUrl ?? null);
		const { id } = /** @type {{ id: number }} */ (db.prepare('SELECT id FROM mods WHERE source = ? AND slug = ?').get(m.source, m.slug));
		const file = `mods/${m.fileName}`;
		const instance = /** @type {{ path: string }} */ (db.prepare('SELECT path FROM server_instances WHERE id = ?').get(instanceId));
		sparseFile(path.join(instance.path, file), Math.max(m.size ?? 0, 22), true);
		db.prepare(
			`INSERT INTO instance_mods (instance_id, mod_id, version, version_id, file_path, hash, hash_algo, enabled, from_pack, installed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(instanceId, id, m.version, m.versionId ?? null, file, m.hash ?? null, m.hash ? 'sha512' : null, m.enabled === false ? 0 : 1, m.fromPack ? 1 : 0, now - 20 * 24 * 3600_000);
	}
};

try {
	for (const scene of scenes) {
		console.log(`scene ${scene.name}`);
		await scene.run(ctx);
	}
} catch (err) {
	if (!keep) cleanup();
	throw err;
}

// The template unit, then the "running" servers.
await act('/settings', 'installUnit');
const bootMs = Date.now() - Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
for (const { id, uptimeMinutes } of toStart) {
	const offset = uptimeMinutes * 60;
	if (offset) fs.writeFileSync(path.join(DATA, 'uptime', id), String(offset));
	await act(`/instances/${id}`, 'power', { verb: 'start', force: 'on' });
	if (!offset) continue;
	// The run MineShell matches the start time with (startphase.ts), moved back as
	// far, with its "Done (" 40 s later. Written under the run's own invocation
	// before the fake logs anything, so history.ts keeps it rather than adding its own.
	const show = sh(realSystemctl, ['--user', 'show', `${PREFIX}@${id}.service`, '-pInvocationID', '-pActiveEnterTimestampMonotonic']).out;
	const invocation = show.match(/^InvocationID=(\w+)/m)?.[1];
	const monotonic = Number(show.match(/^ActiveEnterTimestampMonotonic=(\d+)/m)?.[1] ?? 0);
	if (!invocation || !monotonic) throw new Error(`${id}: no start time from systemd:\n${show}`);
	const startedAt = bootMs + monotonic / 1000 - offset * 1000;
	db.prepare(
		`INSERT INTO server_runs (instance_id, invocation, started_at, done_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (instance_id, invocation) DO UPDATE SET started_at = excluded.started_at, done_at = excluded.done_at`
	).run(id, invocation, Math.round(startedAt), Math.round(startedAt + 40_000));
}
db.close();
const startedList = toStart.map((s) => s.id).join(', ');
if (serve) {
	console.log(`started ${startedList}. Running at ${BASE} (data ${DATA}). End it with: npm run screenshots -- --cleanup`);
	process.exit(0);
}
// Long enough for the monitor's samples, the RCON polls and history's journal read (every 30 s).
console.log(`started ${startedList}; letting them settle`);
await sleep(40_000);
// Pages opened once first, for what the browser does on a first visit.
for (const page of visits) sh(process.execPath, [path.join(REPO, 'tests/tools/pageshot.mjs'), `${BASE}${page}`, path.join(DATA, 'visit.png'), '--eval', 'new Promise((r) => setTimeout(r, 4000))']);

// ---------------------------------------------------------------- shots ---

fs.mkdirSync(OUT, { recursive: true });
let failed = 0;
for (const shot of shots.filter((s) => !only.length || only.includes(s.name))) {
	const out = path.join(OUT, `${shot.name}.png`);
	const shotArgs = [path.join(REPO, 'tests/tools/pageshot.mjs'), `${BASE}${shot.path}`, out, '--width', String(shot.width ?? 1280), '--height', String(shot.height ?? 800)];
	if (shot.waitFor) shotArgs.push('--wait-for', shot.waitFor);
	if (shot.element) shotArgs.push('--element', shot.element);
	for (const step of shot.steps ?? []) shotArgs.push(...('click' in step ? ['--click', step.click] : ['--eval', step.eval]));
	if (shot.settle) shotArgs.push('--eval', `new Promise((r) => setTimeout(r, ${shot.settle}))`);
	const res = sh(process.execPath, shotArgs);
	const gaveUp = /gave up waiting/.test(res.out);
	if (res.code !== 0 || gaveUp) failed++;
	console.log(`${res.code !== 0 ? 'FAILED' : gaveUp ? 'NOT READY' : 'ok'}  ${shot.name}${res.code !== 0 || gaveUp ? `\n${res.out.trim()}` : ''}`);
}

if (keep) console.log(`Left running at ${BASE} (data ${DATA}). End it with: npm run screenshots -- --cleanup`);
else cleanup();
process.exit(failed ? 1 : 0);
