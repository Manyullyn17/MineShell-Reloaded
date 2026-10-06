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

export class RconError extends Error {}

export class RconClient {
	private socket: net.Socket | null = null;
	private queue = new Map<number, (packet: Packet) => void>();
	private nextId = 1;
	private inbox = Buffer.alloc(0);

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
			const resolver = this.queue.get(id) ?? this.queue.get(-1);
			if (resolver) resolver({ id, type, body });
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
				resolve();
			});
			socket.once('error', (err) => {
				clearTimeout(timer);
				reject(new RconError(`RCON connect failed: ${err.message}`));
			});
		});

		const authId = this.nextId++;
		const response = await this.send(authId, TYPE_AUTH, this.password);
		// A failed auth answers with request id -1.
		if (response.id === -1 || (response.type === TYPE_AUTH_RESPONSE && response.id !== authId)) {
			this.close();
			throw new RconError('RCON authentication was rejected. Check the password in settings.');
		}
	}

	private send(id: number, type: number, body: string): Promise<Packet> {
		return new Promise((resolve, reject) => {
			if (!this.socket) return reject(new RconError('RCON socket is not open'));
			const timer = setTimeout(() => {
				this.queue.delete(id);
				reject(new RconError('RCON request timed out'));
			}, this.timeoutMs);
			const settle = (packet: Packet) => {
				clearTimeout(timer);
				this.queue.delete(id);
				this.queue.delete(-1);
				resolve(packet);
			};
			this.queue.set(id, settle);
			this.queue.set(-1, settle);
			this.socket.write(encode(id, type, body));
		});
	}

	async command(cmd: string): Promise<string> {
		const id = this.nextId++;
		const packet = await this.send(id, TYPE_COMMAND, cmd);
		if (packet.type !== TYPE_RESPONSE && packet.type !== TYPE_COMMAND) {
			throw new RconError(`Unexpected RCON response type ${packet.type}`);
		}
		return packet.body;
	}

	close(): void {
		this.socket?.destroy();
		this.socket = null;
		this.queue.clear();
	}
}

/**
 * Commands waiting per server. Vanilla collects an RCON command's output in
 * one buffer for the whole server (cleared when a command starts, read when
 * it ends), so two clients' commands running at once get each other's
 * output: the player list came back holding the tick report. MineShell asks
 * from several places on timers (overview, server list, rail, scheduler),
 * so commands to one server run one after another. Connect and every command
 * time out, so one that hangs holds the rest back for seconds, not forever.
 */
const lines = new Map<string, Promise<unknown>>();

/** Open, run one or more commands, close. Callers never manage the socket. */
export function rconExec(opts: { host?: string; port: number; password: string }, commands: string[]): Promise<string[]> {
	const key = `${opts.host ?? '127.0.0.1'}:${opts.port}`;
	const before = lines.get(key) ?? Promise.resolve();
	const run = before.then(() => execNow(opts, commands));
	const settled = run.catch(() => undefined);
	lines.set(key, settled);
	void settled.then(() => {
		if (lines.get(key) === settled) lines.delete(key);
	});
	return run;
}

async function execNow(opts: { host?: string; port: number; password: string }, commands: string[]): Promise<string[]> {
	const client = new RconClient(opts.host ?? '127.0.0.1', opts.port, opts.password);
	await client.connect();
	try {
		const results: string[] = [];
		for (const cmd of commands) results.push(await client.command(cmd));
		return results;
	} finally {
		client.close();
	}
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
