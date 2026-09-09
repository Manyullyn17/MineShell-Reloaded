import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PRIVILEGE_PREFIX, SYSTEMD_SCOPE, unitName } from './config';
import { bus } from './events';

/**
 * Console output comes from the journal, not from a pty. One `journalctl -f` per
 * instance is started lazily on the first subscriber and torn down a minute
 * after the last one leaves, so idle instances cost nothing.
 */

type Tail = {
	child: ChildProcessWithoutNullStreams;
	/** Ring buffer so a newly opened tab gets immediate context. */
	buffer: string[];
	subscribers: number;
	idleTimer: NodeJS.Timeout | null;
};

const tails = new Map<string, Tail>();
const RING_SIZE = 500;
const IDLE_GRACE_MS = 60_000;

function journalArgs(id: string, backlog: number): string[] {
	const unit = unitName(id);
	const common = ['-n', String(backlog), '-f', '-o', 'cat', '--no-pager'];
	if (SYSTEMD_SCOPE === 'user') {
		return ['journalctl', `--user-unit=${unit}`, ...common];
	}
	return [...PRIVILEGE_PREFIX, 'journalctl', '-u', unit, ...common];
}

function startTail(id: string, backlog: number): Tail {
	const argv = journalArgs(id, backlog);
	const [cmd, ...args] = argv;
	const child = spawn(cmd, args, { env: process.env });

	const tail: Tail = { child, buffer: [], subscribers: 0, idleTimer: null };

	let partial = '';
	const onChunk = (chunk: Buffer) => {
		partial += chunk.toString('utf8');
		const lines = partial.split('\n');
		partial = lines.pop() ?? '';
		const ts = Date.now();
		for (const line of lines) {
			tail.buffer.push(line);
			if (tail.buffer.length > RING_SIZE) tail.buffer.shift();
			bus.publish('console:line', { instanceId: id, line, ts });
		}
	};

	child.stdout.on('data', onChunk);
	child.stderr.on('data', (chunk: Buffer) => {
		const text = chunk.toString('utf8').trim();
		if (text) bus.publish('console:line', { instanceId: id, line: `[journal] ${text}`, ts: Date.now() });
	});
	child.on('close', () => {
		if (tails.get(id) === tail) tails.delete(id);
	});
	child.on('error', (err) => {
		bus.publish('console:line', {
			instanceId: id,
			line: `[mineshell] cannot read the journal: ${err.message}`,
			ts: Date.now()
		});
		if (tails.get(id) === tail) tails.delete(id);
	});

	tails.set(id, tail);
	return tail;
}

export type ConsoleSubscription = {
	backlog: string[];
	close: () => void;
};

export function subscribeConsole(
	id: string,
	backlogLines: number,
	onLine: (line: string, ts: number) => void
): ConsoleSubscription {
	let tail = tails.get(id);
	if (!tail) tail = startTail(id, Math.max(backlogLines, RING_SIZE));
	if (tail.idleTimer) {
		clearTimeout(tail.idleTimer);
		tail.idleTimer = null;
	}
	tail.subscribers += 1;

	const unsubscribe = bus.subscribe('console:line', (payload) => {
		if (payload.instanceId === id) onLine(payload.line, payload.ts);
	});

	return {
		backlog: tail.buffer.slice(-backlogLines),
		close: () => {
			unsubscribe();
			const current = tails.get(id);
			if (!current) return;
			current.subscribers = Math.max(0, current.subscribers - 1);
			if (current.subscribers === 0 && !current.idleTimer) {
				current.idleTimer = setTimeout(() => {
					if (current.subscribers === 0) {
						current.child.kill('SIGTERM');
						tails.delete(id);
					}
				}, IDLE_GRACE_MS);
			}
		}
	};
}

/** One-shot read, used by the crash-log viewer. */
export async function readJournal(id: string, lines: number): Promise<string> {
	const unit = unitName(id);
	const base =
		SYSTEMD_SCOPE === 'user'
			? ['journalctl', `--user-unit=${unit}`]
			: [...PRIVILEGE_PREFIX, 'journalctl', '-u', unit];
	const argv = [...base, '-n', String(lines), '-o', 'cat', '--no-pager'];
	const [cmd, ...args] = argv;
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { env: process.env });
		let out = '';
		child.stdout.on('data', (d) => (out += d.toString()));
		child.on('error', () => resolve(''));
		child.on('close', () => resolve(out));
	});
}

export function stopAllTails(): void {
	for (const [, tail] of tails) tail.child.kill('SIGTERM');
	tails.clear();
}
