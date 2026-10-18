import { and, desc, eq, gt, gte, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { db } from './db';
import { bisectSessions, playerSessions, serverInstances, serverRuns, settings, type ServerInstance } from './db/schema';
import { readJournalEvents, readRun, type JournalEvent } from './journal';
import { diagnoseRun } from './crashdiag';
import { modsDir } from './mods/index';
import { playerEventWithName } from '#lib/shared/consolelines.js';
import { notify } from './notifications';

/**
 * What happened on each server over time, kept in the database: runs (when a
 * start began, reached "Done (", ended) and player sessions (join to leave).
 * Read from the server's journal, continuing from where the last read ended
 * (`history_cursor`), so joins and stops while MineShell was down are caught
 * up on, and the first read takes in what the journal still holds.
 *
 * The journal is the one source: systemd's own lines start and end a run, the
 * server's "Done (" finishes starting, and "x joined the game" / "x left the
 * game" (or "lost connection") open and close sessions. A run ending closes
 * any session still open, since nobody can be online on a stopped server.
 *
 * Crashes, by the overview's rule (lastcrash.ts) applied to every run: a
 * failure that is not an asked-for stop, or stopping on its own before
 * "Done (" (most loaders exit 0 after a startup crash). Exit status 143 is
 * SIGTERM, which only a stop MineShell asked for sends. Each crash is put
 * through the crash analyzer once, and its verdict kept. A run that logged a
 * crash is one too, however it ended: the process can hang on after it (a
 * mod's shutdown hook failing), and the Stop that ends it is an asked-for stop.
 */

const POLL_MS = 30_000;
/** The game's own crash lines (every loader): the server thread is gone, whether or not the process exits. */
const CRASH_LINES = '\\]: Encountered an unexpected exception|\\]: This crash report has been saved to: ';
/** Minecraft 1.21.2+ with pause-when-empty-seconds; nothing is logged when a join ends the pause. */
const PAUSE_LINE = '\\]: Server empty for \\d+ seconds, pausing$';
const PATTERN = `joined the game$|left the game$|lost connection: |\\]: Done \\(|^Started |^Stopped |Main process exited|Deactivated successfully|Failed with result|service: Consumed |${CRASH_LINES}|${PAUSE_LINE}`;

const isStart = (m: string) => /^Started /.test(m);
/**
 * systemd's lines at the end of a run. A clean exit (an RCON stop, a loader
 * exiting 0 after a startup crash) is only "Consumed ... CPU time" on some
 * systemd versions, without "Deactivated successfully": those runs never
 * ended, and such startup crashes were never counted.
 */
const isEnd = (m: string) => /^Stopped |Main process exited|Deactivated successfully|Failed with result|service: Consumed /.test(m);
const isDone = (m: string) => /\]: Done \(/.test(m);
const crashLine = new RegExp(CRASH_LINES);
const pauseLine = new RegExp(PAUSE_LINE);
const isPause = (m: string) => pauseLine.test(m);
/** A log line saying the server crashed. */
export const isCrashLine = (m: string) => crashLine.test(m);

function closeSessions(instanceId: string, at: number, player?: string): void {
	db.update(playerSessions)
		.set({ leftAt: at })
		.where(
			and(
				eq(playerSessions.instanceId, instanceId),
				isNull(playerSessions.leftAt),
				player ? eq(playerSessions.player, player) : undefined
			)
		)
		.run();
}

const STOPPED_ON_REQUEST = 143;

/** A run started while the mod bisect assistant searched is one of its tests. */
function duringBisect(instanceId: string, at: number): boolean {
	return !!db
		.select({ id: bisectSessions.id })
		.from(bisectSessions)
		.where(
			and(
				eq(bisectSessions.instanceId, instanceId),
				lte(bisectSessions.startedAt, at),
				or(isNull(bisectSessions.endedAt), gte(bisectSessions.endedAt, at))
			)
		)
		.get();
}

/**
 * Records how a run ended, and whether that was a crash; called for each of
 * systemd's end lines. Says whether this was the first of them for a run that
 * did not crash (a stop to report), not one of the bisect assistant's tests.
 */
function endRun(instanceId: string, invocation: string, at: number, message: string): boolean {
	const where = and(eq(serverRuns.instanceId, instanceId), eq(serverRuns.invocation, invocation));
	const run = db.select().from(serverRuns).where(where).get();
	if (!run) return false;
	const status = message.match(/Main process exited, code=\w+, status=(\d+)/);
	const exitStatus = status ? Number(status[1]) : run.exitStatus;
	const failed = run.failed || /Failed with result/.test(message);
	const askedToStop = exitStatus === STOPPED_ON_REQUEST;
	const crashed =
		run.crashLoggedAt !== null || (!askedToStop && (failed || (exitStatus !== null && exitStatus !== 0) || run.doneAt === null));
	db.update(serverRuns).set({ endedAt: at, exitStatus, failed, crashed }).where(where).run();
	return run.endedAt === null && !crashed && !run.bisect;
}

/** How long a start took, as a message says it: 45 s, 3 min 10 s. */
function took(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 120 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

/** What applyEvents saw that notifications report (crashes go after their diagnosis). */
export type Happening = { kind: 'start' | 'stop' | 'join' | 'leave'; at: number; detail?: string };

/** Applies journal events, oldest first, to the runs and sessions tables. */
export function applyEvents(instanceId: string, events: JournalEvent[]): Happening[] {
	const happened: Happening[] = [];
	for (const e of events) {
		if (isStart(e.message) && e.invocation) {
			// A run that ended without its stop being logged (killed, power cut) leaves sessions open.
			closeSessions(instanceId, e.at);
			db.insert(serverRuns)
				.values({ instanceId, invocation: e.invocation, startedAt: e.at, bisect: duringBisect(instanceId, e.at) })
				.onConflictDoNothing()
				.run();
			continue;
		}
		if (isDone(e.message) && e.invocation) {
			const where = and(eq(serverRuns.instanceId, instanceId), eq(serverRuns.invocation, e.invocation), isNull(serverRuns.doneAt));
			const run = db.select().from(serverRuns).where(where).get();
			db.update(serverRuns).set({ doneAt: e.at }).where(where).run();
			if (run && !run.bisect) happened.push({ kind: 'start', at: e.at, detail: took(e.at - run.startedAt) });
			// Started cleanly after a one-click fix: the crashes it fixed leave the overview.
			const fix = readNumber(CRASH_FIX(instanceId));
			if (run && !run.bisect && fix && run.startedAt >= fix) {
				writeNumber(CRASHES_CLEARED(instanceId), run.startedAt);
				writeNumber(CRASH_FIX(instanceId), null);
			}
			continue;
		}
		if (isCrashLine(e.message) && e.invocation) {
			db.update(serverRuns)
				.set({ crashLoggedAt: e.at })
				.where(and(eq(serverRuns.instanceId, instanceId), eq(serverRuns.invocation, e.invocation), isNull(serverRuns.crashLoggedAt)))
				.run();
			continue;
		}
		if (isPause(e.message) && e.invocation) {
			db.update(serverRuns)
				.set({ pausedAt: e.at })
				.where(and(eq(serverRuns.instanceId, instanceId), eq(serverRuns.invocation, e.invocation)))
				.run();
			continue;
		}
		if (isEnd(e.message)) {
			if (e.invocation && endRun(instanceId, e.invocation, e.at, e.message)) happened.push({ kind: 'stop', at: e.at });
			closeSessions(instanceId, e.at);
			continue;
		}
		const player = playerEventWithName(e.message);
		if (player?.event === 'join') {
			// A join ends the pause (the game logs nothing for that).
			if (e.invocation) {
				db.update(serverRuns)
					.set({ pausedAt: null })
					.where(and(eq(serverRuns.instanceId, instanceId), eq(serverRuns.invocation, e.invocation)))
					.run();
			}
			const open = db
				.select({ id: playerSessions.id })
				.from(playerSessions)
				.where(and(eq(playerSessions.instanceId, instanceId), eq(playerSessions.player, player.name), isNull(playerSessions.leftAt)))
				.get();
			if (!open) {
				db.insert(playerSessions).values({ instanceId, player: player.name, joinedAt: e.at }).run();
				happened.push({ kind: 'join', at: e.at, detail: player.name });
			}
		} else if (player?.event === 'leave') {
			// "lost connection" and "left the game" both come for one leave: only the first closes a session.
			const open = db
				.select({ id: playerSessions.id })
				.from(playerSessions)
				.where(and(eq(playerSessions.instanceId, instanceId), eq(playerSessions.player, player.name), isNull(playerSessions.leftAt)))
				.get();
			closeSessions(instanceId, e.at, player.name);
			if (open) happened.push({ kind: 'leave', at: e.at, detail: player.name });
		}
	}
	return happened;
}

const HAPPENING_TEXT: Record<Happening['kind'], (detail?: string) => { title: string; message: string }> = {
	start: (took) => ({ title: 'Started', message: `Finished starting${took ? ` in ${took}` : ''}; players can join.` }),
	stop: () => ({ title: 'Stopped', message: 'The server stopped.' }),
	join: (name) => ({ title: `${name} joined`, message: `${name} joined the game.` }),
	leave: (name) => ({ title: `${name} left`, message: `${name} left the game.` })
};

/** Reads one server's new journal entries and records them. */
export async function recordHistory(instance: ServerInstance): Promise<void> {
	const { events, cursor } = await readJournalEvents(instance.id, PATTERN, {
		afterCursor: instance.historyCursor,
		since: instance.createdAt
	});
	const happened = db.transaction(() => {
		const seen = applyEvents(instance.id, events);
		if (cursor !== instance.historyCursor) {
			db.update(serverInstances).set({ historyCursor: cursor }).where(eq(serverInstances.id, instance.id)).run();
		}
		return seen;
	});
	const server = { id: instance.id, name: instance.name };
	for (const h of happened) void notify({ kind: h.kind, instance: server, at: h.at, ...HAPPENING_TEXT[h.kind](h.detail) });
	await diagnoseCrashes(instance);
}

/** Crashes not yet put through the analyzer per pass: each reads the run's log and indexes mods/. */
const DIAGNOSE_PER_PASS = 3;

async function diagnoseCrashes(instance: ServerInstance): Promise<void> {
	const pending = db
		.select()
		.from(serverRuns)
		.where(
			and(eq(serverRuns.instanceId, instance.id), eq(serverRuns.crashed, true), eq(serverRuns.diagnosed, false), eq(serverRuns.bisect, false))
		)
		.orderBy(desc(serverRuns.startedAt))
		.limit(DIAGNOSE_PER_PASS)
		.all();
	for (const run of pending) {
		const found = await diagnoseRun(await readRun(run.invocation, instance.createdAt), modsDir(instance.path), {
			memoryLimitMb: instance.limitMemoryMb
		}).catch(() => []);
		const top = found.find((d) => d.fatal) ?? found[0];
		const cause = top?.title ?? null;
		db.update(serverRuns).set({ cause, diagnosed: true }).where(eq(serverRuns.id, run.id)).run();
		// Reported once the cause is known; a run diagnosed long after it ended is not news.
		const memory = top?.kind === 'memory-killed';
		void notify({
			kind: memory ? 'memory' : 'crash',
			instance: { id: instance.id, name: instance.name },
			title: memory ? 'Killed for its memory' : 'Crashed',
			message: cause ?? 'No cause recognised; its overview in MineShell shows the last output.',
			at: run.endedAt ?? run.crashLoggedAt ?? run.startedAt
		});
	}
}

let timer: NodeJS.Timeout | null = null;
let running = false;

async function recordAll(): Promise<void> {
	if (running) return;
	running = true;
	try {
		for (const instance of db.select().from(serverInstances).all()) {
			await recordHistory(instance).catch((err) =>
				console.warn(`[mineshell] reading history for ${instance.id} failed:`, err instanceof Error ? err.message : err)
			);
		}
	} finally {
		running = false;
	}
}

export function startHistory(): void {
	if (timer) return;
	timer = setInterval(() => void recordAll(), POLL_MS);
	timer.unref?.();
	void recordAll();
}

// ------------------------------------------------------------------ reads ---

/** How long after its crash line a process still running counts as hung: saving worlds on the way out takes a moment. */
export const HUNG_AFTER_CRASH_MS = 60_000;

/**
 * When the current run (the one systemd started at `startedAt`) logged a
 * crash, if that is over a minute ago and the process is still there: it
 * crashed but did not exit, so systemd does not restart it either. Null
 * otherwise. The history is read every 30 s, so this lags by up to that.
 */
export function hungAfterCrash(instanceId: string, startedAt: number, now = Date.now()): number | null {
	if (!startedAt) return null;
	const run = db.select().from(serverRuns).where(eq(serverRuns.instanceId, instanceId)).orderBy(desc(serverRuns.startedAt)).limit(1).get();
	// The run history may not have seen this start yet: an older run is not this one.
	if (!run || run.endedAt !== null || run.crashLoggedAt === null || Math.abs(run.startedAt - startedAt) > 10_000) return null;
	return now - run.crashLoggedAt >= HUNG_AFTER_CRASH_MS ? run.crashLoggedAt : null;
}

/**
 * When the current run (the one systemd started at `startedAt`) paused itself
 * for being empty, if no player joined since; null otherwise. Lags the game
 * by up to the 30 s between history reads, both ways.
 */
export function pausedSince(instanceId: string, startedAt: number): number | null {
	if (!startedAt) return null;
	const run = db.select().from(serverRuns).where(eq(serverRuns.instanceId, instanceId)).orderBy(desc(serverRuns.startedAt)).limit(1).get();
	if (!run || run.endedAt !== null || Math.abs(run.startedAt - startedAt) > 10_000) return null;
	return run.pausedAt;
}

export type StartTimes = {
	lastMs: number;
	lastAt: number;
	usualMs: number | null;
	runs: number;
	/** The newest start is the running server's own, not an earlier run's. */
	current: boolean;
};

/**
 * How long the newest start took to reach "Done (", against the usual (median
 * of the five before). `running` is the running server's start (systemd's) and
 * when it finished starting, if it did: that start is the newest even before
 * the history (read every 30 s) has it.
 */
export function startTimes(instanceId: string, running?: { startedAt: number; doneAt: number | null }): StartTimes | null {
	const rows = db
		.select({ startedAt: serverRuns.startedAt, doneAt: serverRuns.doneAt })
		.from(serverRuns)
		.where(and(eq(serverRuns.instanceId, instanceId), isNotNull(serverRuns.doneAt), eq(serverRuns.bisect, false)))
		.orderBy(desc(serverRuns.startedAt))
		.limit(6)
		.all();
	// The history's start is systemd's "Started" line, a moment off the unit's own timestamp.
	const isRunning = (r: { startedAt: number }) => !!running?.startedAt && Math.abs(r.startedAt - running.startedAt) <= 10_000;
	const runs =
		running?.doneAt && !rows.some(isRunning) ? [{ startedAt: running.startedAt, doneAt: running.doneAt }, ...rows].slice(0, 6) : rows;
	if (!runs.length) return null;
	const took = (r: (typeof runs)[number]) => r.doneAt! - r.startedAt;
	const before = runs.slice(1).map(took).sort((a, b) => a - b);
	return {
		lastMs: took(runs[0]),
		lastAt: runs[0].startedAt,
		usualMs: before.length >= 2 ? before[Math.floor(before.length / 2)] : null,
		runs: runs.length,
		current: !!running?.doneAt && isRunning(runs[0])
	};
}

export type CrashRecord = { invocation: string; at: number; cause: string | null; diagnosed: boolean };

/**
 * The overview's crash list is cleared up to a time (settings, per server): by hand once
 * a start after the newest crash got to "Done", or on its own when a one-click fix was
 * applied and the next start got there. The runs stay; the Logs tab lists them all.
 */
const CRASHES_CLEARED = (id: string) => `crashes.cleared:${id}`;
const CRASH_FIX = (id: string) => `crashes.fix:${id}`;

function readNumber(key: string): number {
	return Number(db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? 0) || 0;
}

function writeNumber(key: string, value: number | null): void {
	if (value === null) db.delete(settings).where(eq(settings.key, key)).run();
	else db.insert(settings).values({ key, value: String(value) }).onConflictDoUpdate({ target: settings.key, set: { value: String(value) } }).run();
}

/** The server's crashes since `since`, newest first, leaving out the ones cleared from the overview. */
export function recentCrashes(instanceId: string, since = Date.now() - 30 * 24 * 3600_000, limit = 10): CrashRecord[] {
	const from = Math.max(since, readNumber(CRASHES_CLEARED(instanceId)));
	return db
		.select()
		.from(serverRuns)
		.where(
			and(eq(serverRuns.instanceId, instanceId), eq(serverRuns.crashed, true), eq(serverRuns.bisect, false), gt(serverRuns.startedAt, from))
		)
		.orderBy(desc(serverRuns.startedAt))
		.limit(limit)
		.all()
		.map((r) => ({ invocation: r.invocation, at: r.endedAt ?? r.startedAt, cause: r.cause, diagnosed: r.diagnosed }));
}

/** Whether the overview's crashes can be cleared: a start after the newest one got to "Done". */
export function crashesClearable(instanceId: string): boolean {
	const [newest] = recentCrashes(instanceId, 0, 1);
	if (!newest) return false;
	const crash = db.select().from(serverRuns).where(and(eq(serverRuns.instanceId, instanceId), eq(serverRuns.invocation, newest.invocation))).get();
	if (!crash) return false;
	return !!db
		.select()
		.from(serverRuns)
		.where(and(eq(serverRuns.instanceId, instanceId), gt(serverRuns.startedAt, crash.startedAt), isNotNull(serverRuns.doneAt)))
		.get();
}

/** Clears the overview's crashes; false (nothing changed) while the server has not started cleanly since. */
export function clearCrashes(instanceId: string): boolean {
	if (!crashesClearable(instanceId)) return false;
	writeNumber(CRASHES_CLEARED(instanceId), Date.now());
	writeNumber(CRASH_FIX(instanceId), null);
	return true;
}

/** A one-click fix was applied: the next start that gets to "Done" clears the crashes. */
export function noteCrashFix(instanceId: string): void {
	writeNumber(CRASH_FIX(instanceId), Date.now());
}

/** Whether a fix waits for a clean start to clear the crashes. */
export function crashFixPending(instanceId: string): boolean {
	return readNumber(CRASH_FIX(instanceId)) > 0;
}

export function deleteCrashMarks(instanceId: string): void {
	writeNumber(CRASHES_CLEARED(instanceId), null);
	writeNumber(CRASH_FIX(instanceId), null);
}

/** The crash analyzer's verdict per crashed run, by invocation id, for the Logs tab. */
export function crashCausesByRun(instanceId: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const r of db
		.select()
		.from(serverRuns)
		.where(and(eq(serverRuns.instanceId, instanceId), eq(serverRuns.crashed, true), eq(serverRuns.bisect, false)))
		.all()) {
		if (r.cause) out[r.invocation] = r.cause;
	}
	return out;
}

/** Start time per run, by invocation id, for the Logs tab's run list. */
export function startTimesByRun(instanceId: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const r of db
		.select()
		.from(serverRuns)
		.where(and(eq(serverRuns.instanceId, instanceId), isNotNull(serverRuns.doneAt), eq(serverRuns.bisect, false)))
		.all()) {
		out[r.invocation] = r.doneAt! - r.startedAt;
	}
	return out;
}

/** Runs that were the mod bisect assistant's tests, for the Logs tab to label. */
export function bisectRuns(instanceId: string): string[] {
	return db
		.select({ invocation: serverRuns.invocation })
		.from(serverRuns)
		.where(and(eq(serverRuns.instanceId, instanceId), eq(serverRuns.bisect, true)))
		.all()
		.map((r) => r.invocation);
}

/** Since when each online player has been on, by name. */
export function onlineSince(instanceId: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const s of db
		.select()
		.from(playerSessions)
		.where(and(eq(playerSessions.instanceId, instanceId), isNull(playerSessions.leftAt)))
		.all()) {
		out[s.player] = s.joinedAt;
	}
	return out;
}

/** The most players online at once since `from` (the start of today, by default). */
export function peakPlayers(instanceId: string, from = startOfToday(), now = Date.now()): number {
	const sessions = db
		.select()
		.from(playerSessions)
		.where(and(eq(playerSessions.instanceId, instanceId), or(isNull(playerSessions.leftAt), gt(playerSessions.leftAt, from))))
		.all();
	const changes: [number, number][] = [];
	for (const s of sessions) {
		if (s.joinedAt > now) continue;
		changes.push([Math.max(s.joinedAt, from), 1], [s.leftAt ?? now, -1]);
	}
	// At the same moment a leave counts before a join, so a relog is not two people.
	changes.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let current = 0;
	let peak = 0;
	for (const [, delta] of changes) {
		current += delta;
		peak = Math.max(peak, current);
	}
	return peak;
}

/** The stretches since `from` when at least one player was online, oldest first, each [start, end]. */
export function playedIntervals(instanceId: string, from: number, now = Date.now()): [number, number][] {
	const sessions = db
		.select()
		.from(playerSessions)
		.where(and(eq(playerSessions.instanceId, instanceId), or(isNull(playerSessions.leftAt), gt(playerSessions.leftAt, from))))
		.all()
		.map((s): [number, number] => [Math.max(s.joinedAt, from), Math.min(s.leftAt ?? now, now)])
		.filter(([start, end]) => end > start)
		.sort((a, b) => a[0] - b[0]);
	const out: [number, number][] = [];
	for (const [start, end] of sessions) {
		const last = out.at(-1);
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else out.push([start, end]);
	}
	return out;
}

export type Playtime = { totalMs: number; lastSeen: number; online: boolean };

/** Per player: time on this server in total, and when last seen (now, while online). */
export function playtimes(instanceId: string, now = Date.now()): Record<string, Playtime> {
	const out: Record<string, Playtime> = {};
	for (const s of db.select().from(playerSessions).where(eq(playerSessions.instanceId, instanceId)).all()) {
		const end = s.leftAt ?? now;
		const p = (out[s.player] ??= { totalMs: 0, lastSeen: 0, online: false });
		p.totalMs += Math.max(0, end - s.joinedAt);
		p.lastSeen = Math.max(p.lastSeen, end);
		if (s.leftAt === null) p.online = true;
	}
	return out;
}

function startOfToday(): number {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}
