#!/usr/bin/env node
/**
 * Asks a running server for its server list answer, as a client's multiplayer list does, and
 * prints the description as the server sent it (JSON). Found the \r a description saved from a
 * textarea carried to every client; the colours themselves still need a real client to see.
 *
 *   node tests/tools/status-ping.mjs <host> <port> [--all]     (--all: the whole answer)
 */
import net from 'node:net';

const [host, rawPort] = process.argv.slice(2);
const port = Number(rawPort);
if (!host || !Number.isInteger(port)) {
	console.error('Usage: node tests/tools/status-ping.mjs <host> <port> [--all]');
	process.exit(1);
}
const all = process.argv.includes('--all');
/** @param {number} n */
const varint = (n) => {
	const bytes = [];
	do {
		let b = n & 0x7f;
		n >>>= 7;
		if (n) b |= 0x80;
		bytes.push(b);
	} while (n);
	return Buffer.from(bytes);
};
/** @param {number} id @param {Buffer} body */
const packet = (id, body) => {
	const data = Buffer.concat([varint(id), body]);
	return Buffer.concat([varint(data.length), data]);
};
const socket = net.connect(port, host, () => {
	const name = Buffer.from(host);
	// Handshake (protocol 769, next state: status), then the status request.
	socket.write(packet(0, Buffer.concat([varint(769), varint(name.length), name, Buffer.from([port >> 8, port & 255]), varint(1)])));
	socket.write(packet(0, Buffer.alloc(0)));
});
let buf = Buffer.alloc(0);
socket.on('data', (/** @type {Buffer} */ chunk) => {
	buf = Buffer.concat([buf, chunk]);
	let i = 0;
	const read = () => {
		let n = 0;
		let shift = 0;
		let b;
		do {
			b = buf[i++];
			n |= (b & 0x7f) << shift;
			shift += 7;
		} while (b & 0x80);
		return n;
	};
	const length = read();
	if (buf.length < i + length) return;
	read();
	const size = read();
	const answer = JSON.parse(buf.subarray(i, i + size).toString());
	console.log(JSON.stringify(all ? answer : answer.description, null, 1));
	socket.end();
});
socket.on('error', (err) => {
	console.error(`No answer from ${host}:${port}: ${err.message}`);
	process.exit(1);
});
