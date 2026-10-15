#!/usr/bin/env node
/**
 * Sends one command to a running server over RCON and prints the answer, for
 * poking at a test server without the UI (pausing Dynmap, listing players).
 *
 *   node tests/tools/rcon.mjs <server folder> <command...>
 *   node tests/tools/rcon.mjs --port 25575 --password secret <command...>
 *
 * Given a folder, the port and password come from its server.properties.
 * Answers over 4096 characters arrive in pieces; this prints the first only.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const args = process.argv.slice(2);
let port;
let password;
if (args[0] === '--port') {
	port = Number(args[1]);
	if (args[2] !== '--password') throw new Error('--port needs --password after it.');
	password = args[3];
	args.splice(0, 4);
} else if (args[0]) {
	const properties = Object.fromEntries(
		fs
			.readFileSync(path.join(String(args.shift()), 'server.properties'), 'utf8')
			.split('\n')
			.filter((l) => l.includes('=') && !l.startsWith('#'))
			.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
	);
	port = Number(properties['rcon.port']);
	password = properties['rcon.password'];
}
const command = args.join(' ');
if (!port || !password || !command) {
	console.error('Usage: node tests/tools/rcon.mjs <server folder> <command...>  (or --port N --password P <command...>)');
	process.exit(1);
}

/** @param {number} id @param {number} type @param {string} body */
const packet = (id, type, body) => {
	const text = Buffer.from(body, 'utf8');
	const out = Buffer.alloc(14 + text.length);
	out.writeInt32LE(10 + text.length, 0);
	out.writeInt32LE(id, 4);
	out.writeInt32LE(type, 8);
	text.copy(out, 12);
	return out;
};

const socket = net.connect(port, '127.0.0.1');
let buffer = Buffer.alloc(0);
socket.on('data', (/** @type {Buffer} */ chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
		const length = buffer.readInt32LE(0);
		const id = buffer.readInt32LE(4);
		const body = buffer.subarray(12, 4 + length - 2).toString('utf8');
		buffer = buffer.subarray(4 + length);
		if (id === -1) {
			console.error('RCON refused the password.');
			process.exit(1);
		}
		if (id === 1) socket.write(packet(2, 2, command));
		if (id === 2) {
			console.log(body);
			socket.end();
		}
	}
});
socket.on('connect', () => socket.write(packet(1, 3, password)));
socket.on('error', (err) => {
	console.error(`RCON on port ${port}: ${err.message}`);
	process.exit(1);
});
