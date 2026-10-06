import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { unitName } from './config';
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

function journalArgs(id: string, backlog: number, since: number): string[] {
	const unit = unitName(id);
	const common = ['-n', String(backlog), '-f', '-o', 'cat', sinceArg(since), '--no-pager'];
	return ['journalctl', `--user-unit=${unit}`, ...common];
}

function startTail(id: string, backlog: number, since: number): Tail {
	const argv = journalArgs(id, backlog, since);
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
	since: number,
	onLine: (line: string, ts: number) => void
): ConsoleSubscription {
	let tail = tails.get(id);
	if (!tail) tail = startTail(id, Math.max(backlogLines, RING_SIZE), since);
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

function journalctl(args: string[]): Promise<string> {
	const [cmd, ...rest] = ['journalctl', '--user', ...args, '--no-pager'];
	return new Promise((resolve) => {
		const child = spawn(cmd, rest, { env: process.env });
		let out = '';
		child.stdout.on('data', (d) => (out += d.toString()));
		child.on('error', () => resolve(''));
		child.on('close', () => resolve(out));
	});
}

function unitMatch(id: string): string[] {
	return [`--user-unit=${unitName(id)}`];
}

/**
 * The journal outlives the instance: a server deleted and recreated under the
 * same name has the same unit, so reads start at the instance's creation.
 */
function sinceArg(since: number): string {
	return `--since=@${Math.floor(since / 1000)}`;
}

/** One-shot read of the newest lines. */
export async function readJournal(id: string, lines: number, since = 0): Promise<string> {
	return journalctl([...unitMatch(id), '-n', String(lines), '-o', 'cat', sinceArg(since)]);
}

/** Big packs log thousands of lines per start; the whole last run is needed. */
const LAST_RUN_LINES = 20000;

const lastRuns = new Map<string, { cursor: string; text: string }>();

/**
 * The unit's last run, for crash detection on the overview, which polls.
 * `journalctl -u` walks matches slowly: 20000 lines take seconds, so reading
 * them on every poll made the overview of a stopped big pack hang. The newest
 * entry costs milliseconds; while its cursor is unchanged the run is the one
 * read before. Otherwise only that run is read, by its invocation id - the
 * service's own lines carry `_SYSTEMD_INVOCATION_ID`, the service manager's
 * ("Started ...", "Consumed ...") `USER_INVOCATION_ID` or `INVOCATION_ID`.
 */
/** The unit's newest entry: its cursor and the invocation (run) it belongs to. Null when there is none. */
async function newestEntry(id: string, since: number): Promise<{ cursor: string | null; invocation: string | null } | null> {
	const newest = (await journalctl([...unitMatch(id), '-n', '1', '-o', 'json', sinceArg(since)])).trim();
	if (!newest) return null;
	let entry: Record<string, unknown> = {};
	try {
		entry = JSON.parse(newest.split('\n')[0]);
	} catch {
		/* unreadable entry: callers fall back to line counts */
	}
	const invocation = [entry._SYSTEMD_INVOCATION_ID, entry.USER_INVOCATION_ID, entry.INVOCATION_ID].find(
		(v): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)
	);
	return { cursor: typeof entry.__CURSOR === 'string' ? entry.__CURSOR : null, invocation: invocation ?? null };
}

/** Every entry of one run: the service's own lines and the service manager's about it. */
function runMatch(invocation: string): string[] {
	return [
		`_SYSTEMD_INVOCATION_ID=${invocation}`,
		'+',
		`USER_INVOCATION_ID=${invocation}`,
		'+',
		`INVOCATION_ID=${invocation}`
	];
}

export async function readLastRun(id: string, since = 0): Promise<string> {
	const entry = await newestEntry(id, since);
	if (!entry) {
		lastRuns.delete(id);
		return '';
	}
	const { cursor, invocation } = entry;
	const hit = lastRuns.get(id);
	if (cursor && hit?.cursor === cursor) return hit.text;

	const text = invocation
		? await journalctl([...runMatch(invocation), '-n', String(LAST_RUN_LINES), '-o', 'cat', sinceArg(since)])
		: await readJournal(id, LAST_RUN_LINES, since);
	if (cursor) lastRuns.set(id, { cursor, text });
	return text;
}

export function stopAllTails(): void {
	for (const [, tail] of tails) tail.child.kill('SIGTERM');
	tails.clear();
}

/**
 * Whether the current run has logged "Done (", searched across the whole
 * run (journalctl -g), so a server running for days whose start has long
 * scrolled out of the last lines still counts as started.
 */
export async function runFinishedStarting(id: string, since = 0): Promise<boolean> {
	const entry = await newestEntry(id, since);
	if (!entry?.invocation) return /\]: Done \(/.test(await readJournal(id, LAST_RUN_LINES, since));
	const found = await journalctl([...runMatch(entry.invocation), '-g', '\\]: Done \\(', '-n', '1', '-o', 'cat', sinceArg(since)]);
	return found.trim().length > 0;
}

export type RunSummary = {
	invocation: string;
	startedAt: number;
	/** When systemd last said something about it (stop, exit); null while running or unknown. */
	endedAt: number | null;
	/** e.g. "status=1/FAILURE"; null while running or for a clean stop. */
	exit: string | null;
	/** systemd's verdict: 'exit-code', 'signal', ... for a failure, null otherwise. */
	failure: string | null;
};

/**
 * The unit's runs that the journal still holds, newest first: when each
 * started and how it ended, from the service manager's own lines. Cheap: a
 * filtered read of those lines only, not the runs' output.
 */
const runLists = new Map<string, { cursor: string; runs: RunSummary[] }>();

export async function listRuns(id: string, since = 0): Promise<RunSummary[]> {
	// The search walks the unit's whole journal (~0.7 s for a big pack's), so
	// it is reused until the journal has something newer.
	const newest = await newestEntry(id, since);
	if (!newest) return [];
	const hit = runLists.get(id);
	if (newest.cursor && hit?.cursor === newest.cursor) return hit.runs;
	const out = await journalctl([
		...unitMatch(id),
		'-o',
		'json',
		'-g',
		'^(Started |Stopped )|Main process exited|Failed with result|Deactivated successfully|Consumed ',
		sinceArg(since)
	]);
	const runs = new Map<string, RunSummary>();
	for (const line of out.split('\n')) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const invocation = [entry.USER_INVOCATION_ID, entry.INVOCATION_ID, entry._SYSTEMD_INVOCATION_ID].find(
			(v): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)
		);
		const message = typeof entry.MESSAGE === 'string' ? entry.MESSAGE : '';
		const at = Math.floor(Number(entry.__REALTIME_TIMESTAMP) / 1000);
		if (!invocation || !Number.isFinite(at)) continue;
		let run = runs.get(invocation);
		if (!run) {
			run = { invocation, startedAt: at, endedAt: null, exit: null, failure: null };
			runs.set(invocation, run);
		}
		if (/^Started /.test(message)) run.startedAt = at;
		else {
			run.endedAt = Math.max(run.endedAt ?? 0, at);
			const exit = message.match(/Main process exited, (code=\w+, status=\S+)/);
			if (exit) run.exit = exit[1].replace(/,$/, '');
			const failed = message.match(/Failed with result '([^']+)'/);
			if (failed) run.failure = failed[1];
		}
	}
	const list = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
	if (newest.cursor) runLists.set(id, { cursor: newest.cursor, runs: list });
	return list;
}

/** One run's output (its last LAST_RUN_LINES lines), by invocation id. */
export async function readRun(invocation: string, since = 0): Promise<string> {
	if (!/^[0-9a-f]{32}$/.test(invocation)) return '';
	return journalctl([...runMatch(invocation), '-n', String(LAST_RUN_LINES), '-o', 'cat', sinceArg(since)]);
}
