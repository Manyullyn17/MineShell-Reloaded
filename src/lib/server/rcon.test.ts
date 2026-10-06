import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { parsePlayerList, rconExec } from './rcon';

describe('parsePlayerList', () => {
	it('reads the 1.13+ format', () => {
		expect(parsePlayerList('There are 2 of a max of 20 players online: Alice, Bob')).toEqual({
			online: 2,
			max: 20,
			names: ['Alice', 'Bob']
		});
		expect(parsePlayerList('There are 0 of a max of 10 players online:')).toEqual({ online: 0, max: 10, names: [] });
	});

	it('reads the 1.12-and-older format', () => {
		// "commands.players.list" before 1.13: "There are %s/%s players online:"
		expect(parsePlayerList('There are 1/20 players online:\nAlice')).toEqual({ online: 1, max: 20, names: ['Alice'] });
		expect(parsePlayerList('There are 0/20 players online:')).toEqual({ online: 0, max: 20, names: [] });
	});
});

/**
 * A server that answers like vanilla's: every RCON client's command writes
 * into one output buffer for the whole server, cleared when a command starts
 * and read when it ends, so overlapping commands get each other's output.
 */
async function sharedBufferServer(): Promise<{ port: number; close: () => void }> {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	let buffer = '';
	const packet = (id: number, type: number, body: string) => {
		const payload = Buffer.from(body);
		const out = Buffer.alloc(payload.length + 14);
		out.writeInt32LE(payload.length + 10, 0);
		out.writeInt32LE(id, 4);
		out.writeInt32LE(type, 8);
		payload.copy(out, 12);
		return out;
	};
	const server = net.createServer((socket) => {
		let inbox = Buffer.alloc(0);
		socket.on('data', async (chunk) => {
			inbox = Buffer.concat([inbox, Buffer.from(chunk)]);
			while (inbox.length >= 4 && inbox.length >= inbox.readInt32LE(0) + 4) {
				const size = inbox.readInt32LE(0);
				const id = inbox.readInt32LE(4);
				const type = inbox.readInt32LE(8);
				const body = inbox.subarray(12, size + 2).toString();
				inbox = inbox.subarray(size + 4);
				if (type === 3) {
					socket.write(packet(id, 2, ''));
					continue;
				}
				buffer = '';
				await sleep(15);
				buffer += `reply to ${body}`;
				await sleep(15);
				socket.write(packet(id, 0, buffer));
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return { port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

describe('rconExec', () => {
	// The overview asked for the player list and the tick rate at once; the
	// list came back with the tick report in it, and a player appeared named
	// "There are 0 of a max of 10 players online:".
	it('runs one command at a time per server, so answers do not mix', async () => {
		const fake = await sharedBufferServer();
		try {
			const opts = { port: fake.port, password: 'pw' };
			const [list, tick] = await Promise.all([rconExec(opts, ['list']), rconExec(opts, ['tick query'])]);
			expect(list).toEqual(['reply to list']);
			expect(tick).toEqual(['reply to tick query']);
		} finally {
			fake.close();
		}
	});
});
