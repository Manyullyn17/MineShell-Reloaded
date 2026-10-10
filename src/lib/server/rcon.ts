import net from 'node:net';

/**
 * Source RCON, implemented directly so MineShell keeps a small dependency
 * surface. Packet layout: int32 length, int32 request id, int32 type, ASCII
 * body, two trailing NULs.
 */
const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_COMMAND = 2;
const TYPE_RESPONSE = 0;

/**
 * The server splits an answer into packets of 4096 characters (Java string
 * length, which is what a JS string's length counts too), all with the
 * command's id: 1.12.2 and 1.21.11 alike, read from their RconClient with javap.
 */
const MAX_FRAGMENT = 4096;

function encode(id: number, type: number, body: string): Buffer {
	const payload = Buffer.from(body, 'utf8');
	const buf = Buffer.alloc(payload.length + 14);
	buf.writeInt32LE(payload.length + 10, 0);
	buf.writeInt32LE(id, 4);
	buf.writeInt32LE(type, 8);
	payload.copy(buf, 12);
	buf.writeInt16LE(0, payload.length + 12);
	return buf;
}

type Packet = { id: number; type: number; body: string };

/** What a request does with each packet: part of its answer, the end of it, or someone else's. */
type Take = (packet: Packet) => 'more' | 'done' | 'skip';

export class RconError extends Error {}

/**
 * The connection went away before the request got any answer. On a connection
 * that sat open since an earlier command (the server restarted meanwhile),
 * the command never reached a running server, so it is sent again once.
 */
class RconClosedError extends RconError {}

/**
 * One connection, one request at a time. Minecraft reads a client's socket in
 * reads of up to 1460 bytes and closes the connection unless a read holds
 * exactly one packet, so nothing is ever sent while a request is waiting -
 * except the end marker below, which goes out once the answer has started
 * arriving (the server writes all of an answer before it reads again).
 */
export class RconClient {
	private socket: net.Socket | null = null;
	private waiting: { take: Take; done: () => void; fail: (err: Error) => void } | null = null;
	private nextId = 1;
	private inbox = Buffer.alloc(0);
	/** The socket is gone (closed by either side, or given up on after a timeout). */
	closed = false;

	constructor(
		private host: string,
		private port: number,
		private password: string,
		private timeoutMs = 5000
	) {}

	private handleData(chunk: Buffer) {
		this.inbox = Buffer.concat([this.inbox, chunk]);
		while (this.inbox.length >= 4) {
			const size = this.inbox.readInt32LE(0);
			if (this.inbox.length < size + 4) break;
			const id = this.inbox.readInt32LE(4);
			const type = this.inbox.readInt32LE(8);
			const body = this.inbox.subarray(12, size + 2).toString('utf8');
			this.inbox = this.inbox.subarray(size + 4);
			// A packet nobody waits for (the answer to a request that timed
			// out) is dropped rather than taken as the next one's answer.
			const waiting = this.waiting;
			if (!waiting) continue;
			let verdict: ReturnType<Take>;
			try {
				verdict = waiting.take({ id, type, body });
			} catch (err) {
				// The rest of that answer may still be coming: start over.
				this.waiting = null;
				waiting.fail(err as Error);
				this.close();
				return;
			}
			if (verdict === 'done') {
				this.waiting = null;
				waiting.done();
			}
		}
	}

	async connect(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const socket = net.createConnection({ host: this.host, port: this.port });
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new RconError(`RCON connect to ${this.host}:${this.port} timed out`));
			}, this.timeoutMs);
			socket.once('connect', () => {
				clearTimeout(timer);
				this.socket = socket;
				// The socket is never put into string mode via setEncoding(), so
				// 'data' always emits Buffer in practice - this guard just makes
				// that explicit for the type checker rather than casting past it.
				socket.on('data', (d) => this.handleData(Buffer.isBuffer(d) ? d : Buffer.from(d)));
				socket.on('error', () => undefined);
				socket.on('close', () => this.close());
				// An idle connection must not keep MineShell (or a test run) alive.
				socket.unref();
				resolve();
			});
			socket.once('error', (err) => {
				clearTimeout(timer);
				this.closed = true;
				reject(new RconError(`RCON connect failed: ${err.message}`));
			});
		});

		const authId = this.nextId++;
		let response: Packet | null = null;
		// A failed auth answers with request id -1.
		await this.request(encode(authId, TYPE_AUTH, this.password), (packet) => {
			if (packet.id !== authId && packet.id !== -1) return 'skip';
			response = packet;
			return 'done';
		});
		const answer = response as Packet | null;
		if (!answer || answer.id === -1 || (answer.type === TYPE_AUTH_RESPONSE && answer.id !== authId)) {
			this.close();
			throw new RconError('RCON authentication was rejected. Check the password in settings.');
		}
	}

	/**
	 * Sends one packet and feeds what comes back to `take` until it says done.
	 * A timeout gives the connection up: an answer still on its way would
	 * otherwise be read as the next request's.
	 */
	private request(packet: Buffer, take: Take): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.closed || !this.socket) return reject(new RconClosedError('RCON connection is closed'));
			const timer = setTimeout(() => {
				this.waiting = null;
				this.close();
				reject(new RconError('RCON request timed out'));
			}, this.timeoutMs);
			let answered = false;
			this.waiting = {
				take: (p) => {
					const verdict = take(p);
					if (verdict !== 'skip') answered = true;
					return verdict;
				},
				done: () => {
					clearTimeout(timer);
					resolve();
				},
				fail: (err) => {
					clearTimeout(timer);
					// Closed halfway through an answer: the command did run.
					reject(answered && err instanceof RconClosedError ? new RconError('RCON connection closed mid-answer') : err);
				}
			};
			this.socket.write(packet);
		});
	}

	async command(cmd: string): Promise<string> {
		const id = this.nextId++;
		const end = this.nextId++;
		let answer = '';
		let marked = false;
		await this.request(encode(id, TYPE_COMMAND, cmd), (packet) => {
			if (marked && packet.id === end) return 'done';
			if (packet.id !== id) return 'skip';
			if (packet.type !== TYPE_RESPONSE && packet.type !== TYPE_COMMAND) {
				throw new RconError(`Unexpected RCON response type ${packet.type}`);
			}
			answer += packet.body;
			if (marked) return 'more';
			if (packet.body.length < MAX_FRAGMENT) return 'done';
			// Maybe more to come. A request of a type the server does not know is
			// answered "Unknown request" after the last piece of this answer.
			marked = true;
			this.socket?.write(encode(end, TYPE_RESPONSE, ''));
			return 'more';
		});
		return answer;
	}

	close(): void {
		this.closed = true;
		this.socket?.destroy();
		this.socket = null;
		const waiting = this.waiting;
		this.waiting = null;
		waiting?.fail(new RconClosedError('RCON connection closed'));
	}
}

/**
 * State shared by every copy of this module: dev HMR re-evaluates it, and a
 * fresh pool would leave the old one's sockets open until their servers stop.
 */
const globals = globalThis as {
	__mineshellRcon?: { lines: Map<string, Promise<unknown>>; pool: Map<string, { client: RconClient; password: string }> };
};
const shared = (globals.__mineshellRcon ??= { lines: new Map(), pool: new Map() });

/**
 * Commands waiting per server. Vanilla collects an RCON command's output in
 * one buffer for the whole server (cleared when a command starts, read when
 * it ends), so two clients' commands running at once get each other's
 * output: the player list came back holding the tick report. MineShell asks
 * from several places on timers (overview, server list, rail, scheduler),
 * so commands to one server run one after another. Connect and every command
 * time out, so one that hangs holds the rest back for seconds, not forever.
 */
const lines = shared.lines;

/**
 * One open connection per server, kept for as long as the server keeps it:
 * every connection is two lines in the server's log, and MineShell asks
 * several times a minute. The server closes it when it stops (Minecraft never
 * drops an idle RCON client: its read timeout is 0), and the next command
 * connects again. Only used inside a server's line, so never by two at once.
 */
const pool = shared.pool;

/** `timeoutMs` is for tests: connect and each command otherwise get 5 s. */
export type RconTarget = { host?: string; port: number; password: string; timeoutMs?: number };

/** Run one or more commands on the server's connection. Callers never manage the socket. */
export function rconExec(opts: RconTarget, commands: string[]): Promise<string[]> {
	const key = `${opts.host ?? '127.0.0.1'}:${opts.port}`;
	const before = lines.get(key) ?? Promise.resolve();
	const run = before.then(() => execNow(key, opts, commands));
	const settled = run.catch(() => undefined);
	lines.set(key, settled);
	void settled.then(() => {
		if (lines.get(key) === settled) lines.delete(key);
	});
	return run;
}

async function execNow(key: string, opts: RconTarget, commands: string[]): Promise<string[]> {
	const results: string[] = [];
	for (const cmd of commands) results.push(await commandOn(key, opts, cmd));
	return results;
}

async function commandOn(key: string, opts: RconTarget, cmd: string): Promise<string> {
	const held = pool.get(key);
	if (held && !held.client.closed && held.password === opts.password) {
		try {
			return await held.client.command(cmd);
		} catch (err) {
			if (!(err instanceof RconClosedError)) throw err;
		}
	} else {
		// Gone, or the password changed in the settings since it logged in.
		held?.client.close();
	}
	pool.delete(key);
	const client = new RconClient(opts.host ?? '127.0.0.1', opts.port, opts.password, opts.timeoutMs);
	await client.connect();
	pool.set(key, { client, password: opts.password });
	return client.command(cmd);
}

/**
 * Parse the vanilla `list` output. 1.13+ says "There are 2 of a max of 20
 * players online: a, b"; 1.12 and older say "There are 2/20 players online:"
 * with the names after it (on the next line over RCON).
 */
export function parsePlayerList(raw: string): { online: number; max: number; names: string[] } {
	const counts = raw.match(/There are (\d+)(?:\/(\d+)| of a max(?: of)? (\d+))? players? online/i);
	const online = counts ? Number(counts[1]) : 0;
	const max = counts ? Number(counts[2] ?? counts[3] ?? 0) : 0;
	const namesPart = raw.split(':').slice(1).join(':').trim();
	const names = namesPart
		? namesPart
				.split(',')
				.map((n) => n.trim())
				.filter(Boolean)
		: [];
	return { online, max, names };
}
