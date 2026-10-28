#!/usr/bin/env node
/**
 * Node's download crash (docs/notes/packs-and-mods.md): a host that sends a whole file and then
 * closes the connection (HTTP/1.0, as Python's http.server) while the file write holds the
 * stream back ends the process with `assert(!this.paused)` in undici's Parser.finish, out of
 * reach of any catch. Serves such a file on loopback and reads it the way downloadFile does,
 * five times, with this Node's built-in fetch or, with --undici, the undici package's.
 *
 *   node tests/tools/fetch-close.mjs [--undici] [--mb 80]
 *
 * Prints "ok" per round; a crash ends it with the assertion and a non-zero exit.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const args = process.argv.slice(2);
const mb = Number(args[args.indexOf('--mb') + 1]) || 80;
const fetchImpl = args.includes('--undici') ? (await import('undici')).fetch : fetch;
const body = Buffer.alloc(mb * 1024 * 1024, 7);

const server = net.createServer((socket) => {
	socket.once('data', () => {
		socket.write(`HTTP/1.0 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\n\r\n`);
		socket.end(body);
	});
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(null)));
const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/file.bin`;
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-close-')), 'file.bin');

console.log(`node ${process.version}, ${args.includes('--undici') ? 'undici package' : `built-in fetch (undici ${process.versions.undici})`}`);
for (let round = 1; round <= 5; round++) {
	const res = await fetchImpl(url);
	let received = 0;
	const source = Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (res.body));
	source.on('data', (/** @type {Buffer} */ chunk) => (received += chunk.length));
	await pipeline(source, fs.createWriteStream(out));
	console.log(`round ${round}: ok, ${received} bytes`);
}
fs.rmSync(path.dirname(out), { recursive: true });
server.close();
