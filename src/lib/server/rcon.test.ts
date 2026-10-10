import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
 * A server that answers like vanilla's RconClient (1.12.2 and 1.21.11 read
 * with javap): every RCON client's command writes into one output buffer for
 * the whole server, cleared when a command starts and read when it ends, so
 * overlapping commands get each other's output; a read holding more than one
 * packet closes the connection; answers go out in pieces of 4096 characters;
 * a request of an unknown type is answered "Unknown request <hex>".
 * `long N` answers N characters, `late` answers after 300 ms.
 */
async function fakeServer() {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	let buffer = '';
	const sockets = new Set<net.Socket>();
	const state = { password: 'pw', connections: 0, ran: [] as string[], dropNextCommand: false, broken: 0 };
	const packet = (id: number, type: number, body: string) => {
		const payload = Buffer.from(body);
		const out = Buffer.alloc(payload.length + 14);
		out.writeInt32LE(payload.length + 10, 0);
		out.writeInt32LE(id, 4);
		out.writeInt32LE(type, 8);
		payload.copy(out, 12);
		return out;
	};
	const answer = (socket: net.Socket, id: number, text: string) => {
		do {
			socket.write(packet(id, 0, text.slice(0, 4096)));
			text = text.slice(4096);
		} while (text.length > 0);
	};
	const server = net.createServer((socket) => {
		state.connections++;
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => undefined);
		let authed = false;
		let inbox = Buffer.alloc(0);
		let line = Promise.resolve();
		socket.on('data', (chunk) => {
			inbox = Buffer.concat([inbox, Buffer.from(chunk)]);
			if (inbox.length < 4 || inbox.length < inbox.readInt32LE(0) + 4) return;
			if (inbox.length !== inbox.readInt32LE(0) + 4) {
				state.broken++;
				socket.destroy();
				return;
			}
			const id = inbox.readInt32LE(4);
			const type = inbox.readInt32LE(8);
			const body = inbox.subarray(12, inbox.length - 2).toString();
			inbox = Buffer.alloc(0);
			line = line.then(async () => {
				if (type === 3) {
					authed = body === state.password;
					socket.write(packet(authed ? id : -1, 2, ''));
					return;
				}
				if (type !== 2 || !authed) {
					answer(socket, id, `Unknown request ${type.toString(16)}`);
					return;
				}
				if (state.dropNextCommand) {
					state.dropNextCommand = false;
					socket.destroy();
					return;
				}
				state.ran.push(body);
				if (body === 'late') {
					await sleep(300);
					answer(socket, id, 'late reply');
					return;
				}
				const long = body.match(/^long (\d+)$/);
				buffer = '';
				await sleep(15);
				buffer += long ? 'é'.repeat(Number(long[1])) : `reply to ${body}`;
				await sleep(15);
				answer(socket, id, buffer);
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		state,
		opts: { port: (server.address() as net.AddressInfo).port, password: 'pw', timeoutMs: 200 },
		/** What a server restart does to the connections it holds. */
		dropClients: () => sockets.forEach((s) => s.destroy()),
		close: () => {
			sockets.forEach((s) => s.destroy());
			server.close();
		}
	};
}

describe('rconExec', () => {
	let fake: Awaited<ReturnType<typeof fakeServer>>;
	beforeEach(async () => {
		fake = await fakeServer();
	});
	afterEach(() => fake.close());

	// The overview asked for the player list and the tick rate at once; the
	// list came back with the tick report in it, and a player appeared named
	// "There are 0 of a max of 10 players online:".
	it('runs one command at a time per server, so answers do not mix', async () => {
		const [list, tick] = await Promise.all([rconExec(fake.opts, ['list']), rconExec(fake.opts, ['tick query'])]);
		expect(list).toEqual(['reply to list']);
		expect(tick).toEqual(['reply to tick query']);
	});

	// Every connection is two lines in the server's log, and MineShell opened
	// one for each command: several a minute per server.
	it('keeps one connection per server for every command', async () => {
		expect(await rconExec(fake.opts, ['a', 'b'])).toEqual(['reply to a', 'reply to b']);
		const answers = await Promise.all(['c', 'd', 'e', 'f'].map((c) => rconExec(fake.opts, [c])));
		expect(answers).toEqual([['reply to c'], ['reply to d'], ['reply to e'], ['reply to f']]);
		expect(fake.state.connections).toBe(1);
	});

	it('connects again after the server closed the connection', async () => {
		await rconExec(fake.opts, ['list']);
		fake.dropClients();
		await new Promise((r) => setTimeout(r, 20));
		expect(await rconExec(fake.opts, ['list'])).toEqual(['reply to list']);
		expect(fake.state.connections).toBe(2);
	});

	// A server restarted while the connection sat idle: the command went to a
	// dead connection and never ran, so it is sent once more on a new one.
	it('sends a command again when the kept connection turns out to be dead', async () => {
		await rconExec(fake.opts, ['list']);
		fake.state.dropNextCommand = true;
		expect(await rconExec(fake.opts, ['say hi'])).toEqual(['reply to say hi']);
		expect(fake.state.ran).toEqual(['list', 'say hi']);
		expect(fake.state.connections).toBe(2);
	});

	it('does not read a timed-out answer as the next command\'s', async () => {
		await expect(rconExec(fake.opts, ['late'])).rejects.toThrow('timed out');
		expect(await rconExec(fake.opts, ['list'])).toEqual(['reply to list']);
		await new Promise((r) => setTimeout(r, 150));
		expect(await rconExec(fake.opts, ['list'])).toEqual(['reply to list']);
		expect(fake.state.ran).toEqual(['late', 'list', 'list']);
	});

	// Only the first 4096 characters came back; on a kept connection the rest
	// would have been the next command's answer.
	it('reads an answer the server split into several packets whole', async () => {
		const [long, exact, next] = await rconExec(fake.opts, ['long 10000', 'long 4096', 'list']);
		expect(long).toBe('é'.repeat(10000));
		expect(exact).toBe('é'.repeat(4096));
		expect(next).toBe('reply to list');
		expect(fake.state.broken).toBe(0);
		expect(fake.state.connections).toBe(1);
	});

	it('logs in again when the password changed', async () => {
		await rconExec(fake.opts, ['list']);
		fake.state.password = 'new';
		expect(await rconExec({ ...fake.opts, password: 'new' }, ['list'])).toEqual(['reply to list']);
		expect(fake.state.connections).toBe(2);
	});

	it('does not keep a connection whose login was rejected', async () => {
		await expect(rconExec({ ...fake.opts, password: 'wrong' }, ['list'])).rejects.toThrow('authentication was rejected');
		expect(await rconExec(fake.opts, ['list'])).toEqual(['reply to list']);
		expect(fake.state.ran).toEqual(['list']);
	});
});
