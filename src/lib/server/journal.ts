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

/**
 * The unit's last run, for crash detection on the overview, which polls.
 * `journalctl -u` walks matches slowly: 20000 lines take seconds, so reading
 * them on every poll made the overview of a stopped big pack hang. The newest
 * entry costs milliseconds; while its cursor is unchanged the run is the one
 * read before. Otherwise only that run is read, by its invocation id - the
 * service's own lines carry `_SYSTEMD_INVOCATION_ID`, the service manager's
 * ("Started ...", "Consumed ...") `USER_INVOCATION_ID` or `INVOCATION_ID`.
 */
export async function readLastRun(id: string, since = 0): Promise<string> {
	const entry = await newestEntry(id, since);
	if (!entry) {
		lastRuns.delete(id);
		return '';
	}
	const { cursor, invocation } = entry;
	const hit = lastRuns.get(id);
	if (cursor && hit?.cursor === cursor) return hit.text;

	const text = invocation ? await readRun(invocation, since) : await readJournal(id, LAST_RUN_LINES, since);
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
const runLists = new Map<string, { cursor: string; runs: Map<string, RunSummary> }>();

export async function listRuns(id: string, since = 0): Promise<RunSummary[]> {
	// The search walks the unit's whole journal (~1-3 s for a big pack's), so
	// the runs are kept and only entries after the newest one seen are searched:
	// a running server logs all the time, and every Logs visit re-read it all.
	const newest = await newestEntry(id, since);
	if (!newest) return [];
	const key = `${id}@${since}`;
	const hit = runLists.get(key);
	if (!(newest.cursor && hit?.cursor === newest.cursor)) {
		const out = await journalctl([
			...unitMatch(id),
			'-o',
			'json',
			'-g',
			'^(Started |Stopped )|Main process exited|Failed with result|Deactivated successfully|Consumed ',
			hit ? `--after-cursor=${hit.cursor}` : sinceArg(since)
		]);
		// Entries logged between reading the newest one and this search are read
		// again next time; merging is idempotent, so that is harmless.
		const runs = new Map(hit?.runs);
		mergeRuns(runs, out);
		if (newest.cursor) runLists.set(key, { cursor: newest.cursor, runs });
		else runLists.delete(key);
		return sortRuns(runs);
	}
	return sortRuns(hit.runs);
}

function sortRuns(runs: Map<string, RunSummary>): RunSummary[] {
	return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Folds the service manager's lines (journalctl -o json) into `runs`, by invocation. */
function mergeRuns(runs: Map<string, RunSummary>, out: string): void {
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
		const message = messageOf(entry.MESSAGE);
		const at = Math.floor(Number(entry.__REALTIME_TIMESTAMP) / 1000);
		if (!invocation || !Number.isFinite(at)) continue;
		// Copied, not changed in place: a list handed out earlier stays as it was.
		const run: RunSummary = { ...(runs.get(invocation) ?? { invocation, startedAt: at, endedAt: null, exit: null, failure: null }) };
		runs.set(invocation, run);
		if (/^Started /.test(message)) run.startedAt = at;
		else {
			run.endedAt = Math.max(run.endedAt ?? 0, at);
			const exit = message.match(/Main process exited, (code=\w+, status=\S+)/);
			if (exit) run.exit = exit[1].replace(/,$/, '');
			const failed = message.match(/Failed with result '([^']+)'/);
			if (failed) run.failure = failed[1];
		}
	}
}

/** Runs' text read so far, by invocation, with the cursor of the last line read. */
const runTexts = new Map<string, { cursor: string; text: string }>();
/** A big pack's run is a few MB of text; the Logs page and the overview need only a few. */
const RUN_TEXTS_KEPT = 8;

/**
 * One run's output (its last LAST_RUN_LINES lines), by invocation id. Reading
 * 20000 lines takes journalctl 1-2 s, so the text is kept and later calls
 * read only what the run logged since (nothing, once it has ended).
 */
export async function readRun(invocation: string, since = 0): Promise<string> {
	if (!/^[0-9a-f]{32}$/.test(invocation)) return '';
	const key = `${invocation}@${since}`;
	const hit = runTexts.get(key);
	const out = await journalctl([
		...runMatch(invocation),
		...(hit ? [`--after-cursor=${hit.cursor}`] : ['-n', String(LAST_RUN_LINES), sinceArg(since)]),
		'-o',
		'cat',
		'--show-cursor'
	]);
	// --show-cursor ends the output with "-- cursor: <cursor>" (also when nothing was new).
	const end = out.lastIndexOf('\n-- cursor: ');
	const cursorLine = end >= 0 ? out.slice(end + 1) : out.startsWith('-- cursor: ') ? out : '';
	const added = end >= 0 ? out.slice(0, end + 1) : cursorLine ? '' : out;
	let text = (hit?.text ?? '') + added;
	if (hit && added) {
		const lines = text.split('\n');
		// The last element is what follows the final newline: empty.
		if (lines.length > LAST_RUN_LINES + 1) text = lines.slice(-(LAST_RUN_LINES + 1)).join('\n');
	}
	const cursor = cursorLine.slice('-- cursor: '.length).trim();
	runTexts.delete(key);
	if (cursor) {
		runTexts.set(key, { cursor, text });
		if (runTexts.size > RUN_TEXTS_KEPT) runTexts.delete(runTexts.keys().next().value!);
	}
	return text;
}

export type JournalEvent = { at: number; message: string; invocation: string | null };

/**
 * The unit's entries matching `pattern` (journalctl -g) after `afterCursor`
 * (or from `since` on the first read), with the position to continue from.
 * The position is the newest entry, read first, not the last match: a server
 * that logged for days without a match would otherwise be scanned from the
 * same old cursor on every call. Matches newer than that entry are left for
 * the next call, which starts after it.
 */
export async function readJournalEvents(
	id: string,
	pattern: string,
	from: { afterCursor: string | null; since: number }
): Promise<{ events: JournalEvent[]; cursor: string | null }> {
	const newest = (await journalctl([...unitMatch(id), '-n', '1', '-o', 'json', sinceArg(from.since)])).trim();
	if (!newest) return { events: [], cursor: from.afterCursor };
	let head: Record<string, unknown>;
	try {
		head = JSON.parse(newest.split('\n')[0]);
	} catch {
		return { events: [], cursor: from.afterCursor };
	}
	const cursor = typeof head.__CURSOR === 'string' ? head.__CURSOR : null;
	const until = Number(head.__REALTIME_TIMESTAMP);
	if (!cursor || (from.afterCursor && cursor === from.afterCursor)) return { events: [], cursor: from.afterCursor };

	const out = await journalctl([
		...unitMatch(id),
		...(from.afterCursor ? [`--after-cursor=${from.afterCursor}`] : [sinceArg(from.since)]),
		'-o',
		'json',
		'-g',
		pattern
	]);
	return { events: parseEvents(out, until), cursor };
}

/**
 * The unit's lines logged in the same millisecond as `at`, oldest first: the
 * lines of one multi-line message, which journald stores with one timestamp.
 * Reads only that second of the journal.
 */
export async function readMessageAt(id: string, at: number): Promise<string[]> {
	const second = Math.floor(at / 1000);
	const out = await journalctl([...unitMatch(id), '-o', 'json', `--since=@${second}`, `--until=@${second + 1}`]);
	return parseEvents(out)
		.filter((e) => e.at === at)
		.map((e) => e.message);
}

/**
 * A MESSAGE field: text, or - for a line with control characters, like the
 * colour codes modern Forge prints - an array of its bytes.
 */
function messageOf(field: unknown): string {
	if (typeof field === 'string') return field;
	if (Array.isArray(field) && field.every((b) => typeof b === 'number')) return Buffer.from(field).toString('utf8');
	return '';
}

/** `journalctl -o json` output as events, oldest first; none after `until` (µs) if given. */
function parseEvents(out: string, until = Infinity): JournalEvent[] {
	const events: JournalEvent[] = [];
	for (const line of out.split('\n')) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const at = Number(entry.__REALTIME_TIMESTAMP);
		if (!Number.isFinite(at) || at > until) continue;
		const message = messageOf(entry.MESSAGE);
		const invocation = [entry._SYSTEMD_INVOCATION_ID, entry.USER_INVOCATION_ID, entry.INVOCATION_ID].find(
			(v): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)
		);
		events.push({ at: Math.floor(at / 1000), message, invocation: invocation ?? null });
	}
	return events.sort((a, b) => a.at - b.at);
}

/** One run's lines containing `text`, in any case, oldest first (the newest `limit`). */
export async function searchRun(invocation: string, text: string, since = 0, limit = 5000): Promise<string[]> {
	if (!/^[0-9a-f]{32}$/.test(invocation)) return [];
	const out = await journalctl([...runMatch(invocation), '-o', 'cat', '-g', grepPattern(text), '--case-sensitive=false', '-n', String(limit), sinceArg(since)]);
	return out.split('\n').filter((line) => line.length > 0);
}

/** journalctl -g takes a regular expression: the text, escaped. */
function grepPattern(text: string): string {
	return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/**
 * The unit's lines containing `text`, in any case: the newest `limit` of them,
 * oldest first. journalctl -g takes a regular expression, so the text is
 * escaped; it walks the whole journal (~0.5 s for a big pack's), which is
 * fine for a search someone asked for, never for anything polled.
 */
export async function searchJournal(id: string, text: string, since = 0, limit = 2000): Promise<JournalEvent[]> {
	const out = await journalctl([...unitMatch(id), '-o', 'json', '-g', grepPattern(text), '--case-sensitive=false', '-n', String(limit), sinceArg(since)]);
	return parseEvents(out);
}
