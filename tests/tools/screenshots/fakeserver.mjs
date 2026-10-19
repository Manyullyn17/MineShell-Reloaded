#!/usr/bin/env node
/**
 * Stands in for Java in a screenshot run (tests/tools/screenshots/README.md):
 * the server's pinned Java path is a script that runs this, under MineShell's
 * real systemd unit. It prints a vanilla server's log (the journal is the
 * console), answers RCON the way vanilla does for what MineShell asks (list,
 * list uuids, tick query, stop) and holds memory and some CPU, so status,
 * players, TPS and the performance graph all come through MineShell's own code.
 *
 * Everything it shows comes from fake-server.json in its working directory
 * (the server folder), written by the scenes:
 *   { version, players: [{ name, uuid }], chat: [[name, text, seconds after the line before]],
 *     mspt, memoryMb, cpuPercent, uptimeMinutes }
 * A chat name '*' prints the text as a plain server line (advancements, deaths).
 * The RCON port and password are read from server.properties, as the game does.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

const config = JSON.parse(fs.readFileSync('fake-server.json', 'utf8'));
const properties = Object.fromEntries(
	fs
		.readFileSync('server.properties', 'utf8')
		.split('\n')
		.filter((l) => l.includes('=') && !l.startsWith('#'))
		.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
);
/** @type {{ name: string; uuid: string }[]} */
const players = config.players ?? [];
const maxPlayers = Number(properties['max-players'] ?? 20);

// The time each line says it was written. The console shows the log's own
// "[HH:MM:SS]", not the journal's, so the run can tell a story of hours
// (started `uptimeMinutes` ago, players joining over time, chat spread out)
// while printing it all at once.
const now = Date.now();
const uptimeMs = (config.uptimeMinutes ?? 0) * 60_000;
let clock = now - uptimeMs;
/** Once the story is told: what happens from then on (RCON clients, say, stop) at the real time. */
let live = false;
/** @param {number} msAgo  a moment before now, never before the start */
const at = (msAgo) => (clock = now - Math.max(0, Math.min(msAgo, uptimeMs)));
/** @param {string} thread @param {string} text */
const log = (thread, text, level = 'INFO') => {
	const time = new Date(live ? Date.now() : clock).toTimeString().slice(0, 8);
	console.log(`[${time}] [${thread}/${level}]: ${text}`);
};
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Memory a server of this size would hold, touched so it is resident (the
// cgroup counts it), and CPU in short bursts around the asked-for share.
const held = [];
for (let mb = 0; mb < (config.memoryMb ?? 512); mb += 64) held.push(Buffer.alloc(64 * 1024 * 1024, 1));
setInterval(() => {
	// Milliseconds of every 100 busy: the percent of one core.
	const busy = (config.cpuPercent ?? 10) * (0.7 + Math.random() * 0.6);
	const until = performance.now() + Math.min(busy, 95);
	while (performance.now() < until);
}, 100);

function tickQuery() {
	const mspt = (config.mspt ?? 8) * (0.9 + Math.random() * 0.2);
	const p = (/** @type {number} */ f) => (mspt * f).toFixed(1);
	return (
		'The game is running normally\n' +
		'Target tick rate: 20.0 per second.\n' +
		`Average time per tick: ${mspt.toFixed(1)}ms (Target: 50.0ms)\n` +
		`Percentiles: P50: ${p(0.95)}ms P95: ${p(1.4)}ms P99: ${p(1.8)}ms, sample: 100`
	);
}

/** @param {string} command */
function answer(command) {
	const cmd = command.trim().replace(/^\//, '');
	const names = players.map((p) => p.name);
	if (cmd === 'list') return `There are ${names.length} of a max of ${maxPlayers} players online: ${names.join(', ')}`;
	if (cmd === 'list uuids')
		return `There are ${names.length} of a max of ${maxPlayers} players online: ${players.map((p) => `${p.name} (${p.uuid})`).join(', ')}`;
	if (cmd === 'tick query') return tickQuery();
	if (cmd === 'save-all' || cmd === 'save-all flush') return 'Saving the game (this may take a moment!)Saved the game';
	if (cmd === 'save-off') return 'Automatic saving is now disabled';
	if (cmd === 'save-on') return 'Automatic saving is now enabled';
	if (cmd.startsWith('say ')) {
		log('Server thread', `[Rcon] ${cmd.slice(4)}`);
		return '';
	}
	if (cmd === 'stop') {
		setTimeout(shutdown, 200);
		return 'Stopping the server';
	}
	return 'Unknown or incomplete command, see below for error';
}

function shutdown() {
	log('Server thread', 'Stopping server');
	log('Server thread', 'Saving players');
	log('Server thread', 'Saving worlds');
	log('Server thread', 'ThreadedAnvilChunkStorage: All dimensions are saved');
	process.exit(0);
}
process.on('SIGTERM', shutdown);

/**
 * Minecraft's RCON: little-endian length, request id, type, body, two NULs.
 * @param {number} id @param {number} type @param {string} body
 */
function packet(id, type, body) {
	const text = Buffer.from(body, 'utf8');
	const out = Buffer.alloc(14 + text.length);
	out.writeInt32LE(10 + text.length, 0);
	out.writeInt32LE(id, 4);
	out.writeInt32LE(type, 8);
	text.copy(out, 12);
	return out;
}

/** @param {net.Socket} socket */
function rcon(socket) {
	let authed = false;
	let pending = Buffer.alloc(0);
	log('RCON Listener #1', `Thread RCON Client /127.0.0.1 started`);
	socket.on('data', (/** @type {Buffer} */ chunk) => {
		pending = Buffer.concat([pending, chunk]);
		while (pending.length >= 4) {
			const length = pending.readInt32LE(0);
			if (pending.length < 4 + length) break;
			const id = pending.readInt32LE(4);
			const type = pending.readInt32LE(8);
			const body = pending.subarray(12, 4 + length - 2).toString('utf8');
			pending = pending.subarray(4 + length);
			if (type === 3) {
				authed = body === properties['rcon.password'];
				socket.write(packet(authed ? id : -1, 2, ''));
			} else if (!authed) socket.destroy();
			else if (type === 2) socket.write(packet(id, 0, answer(body)));
			else socket.write(packet(id, 0, `Unknown request ${type.toString(16)}`));
		}
	});
	socket.on('error', () => undefined);
}

const port = properties['server-port'] ?? '25565';
// Startup, in the time a modest server takes (40 s to "Done", as the run MineShell is told of).
const start = clock;
/** @param {number} ms */
const after = (ms) => (clock = start + Math.min(ms, uptimeMs || 0));
log('ServerMain', 'Environment: Environment[sessionHost=https://sessionserver.mojang.com, servicesHost=https://api.minecraftservices.com, name=PROD]');
after(4_200);
log('ServerMain', 'Loaded 1370 recipes');
log('ServerMain', 'Loaded 1481 advancements');
after(6_900);
log('Server thread', `Starting minecraft server version ${config.version}`);
log('Server thread', 'Loading properties');
log('Server thread', `Default game type: ${(properties.gamemode ?? 'survival').toUpperCase()}`);
log('Server thread', 'Generating keypair');
after(7_400);
log('Server thread', `Starting Minecraft server on *:${port}`);
log('Server thread', 'Using epoll channel type');
after(8_300);
log('Server thread', `Preparing level "${properties['level-name'] ?? 'world'}"`);
for (const [ms, pct] of [[11_000, 0], [17_000, 18], [24_000, 49], [31_000, 83], [36_000, 100]]) {
	after(ms);
	log(`Worker-Main-${1 + (pct % 3)}`, `Preparing spawn area: ${pct}%`);
}
after(38_400);
log('Server thread', 'Time elapsed: 27412 ms');
log('Server thread', `Done (${uptimeMs ? '38.412' : '1.204'}s)! For help, type "help"`);
if (properties['enable-rcon'] === 'true') {
	log('Server thread', 'Starting remote control listener');
	log('Server thread', 'Thread RCON Listener started');
	net.createServer(rcon).listen(Number(properties['rcon.port']), '0.0.0.0');
	log('RCON Listener #1', `RCON running on 0.0.0.0:${properties['rcon.port']}`);
}

// Players joined over the last hour and a half (95, 41, 19, 11 ... minutes ago), chat in the last few minutes.
let entity = 140;
for (const [i, player] of players.entries()) {
	await sleep(50);
	at((90 * 0.4 ** i + 5) * 60_000 + i * 17_000);
	const ip = `203.0.113.${crypto.randomInt(2, 250)}:${crypto.randomInt(40000, 65000)}`;
	log('User Authenticator #1', `UUID of player ${player.name} is ${player.uuid}`);
	log('Server thread', `${player.name}[/${ip}] logged in with entity id ${entity++} at (${(Math.random() * 400 - 200).toFixed(1)}, 64.0, ${(Math.random() * 400 - 200).toFixed(1)})`);
	log('Server thread', `${player.name} joined the game`);
}
// Chat, counted back from the last line (half a minute ago) by each line's gap
// after the one before it (75 s when it gives none).
const chat = /** @type {[string, string, number?][]} */ (config.chat ?? []);
const chatAgo = chat.map(() => 30_000);
for (let i = chat.length - 2; i >= 0; i--) chatAgo[i] = chatAgo[i + 1] + (chat[i + 1][2] ?? 75) * 1000;
for (const [i, [name, text]] of chat.entries()) {
	await sleep(50);
	at(chatAgo[i]);
	if (name === '*') log('Server thread', text);
	else log('Server thread', `<${name}> ${text}`);
}
live = true;
