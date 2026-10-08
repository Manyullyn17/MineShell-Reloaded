import { and, desc, eq, gt, gte, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { db } from './db';
import { bisectSessions, playerSessions, serverInstances, serverRuns, type ServerInstance } from './db/schema';
import { readJournalEvents, readRun, type JournalEvent } from './journal';
import { diagnoseRun } from './crashdiag';
import { modsDir } from './mods/index';
import { playerEventWithName } from '#lib/shared/consolelines.js';

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
 * through the crash analyzer once, and its verdict kept.
 */

const POLL_MS = 30_000;
const PATTERN =
	'joined the game$|left the game$|lost connection: |\\]: Done \\(|^Started |^Stopped |Main process exited|Deactivated successfully|Failed with result|service: Consumed ';

const isStart = (m: string) => /^Started /.test(m);
/**
 * systemd's lines at the end of a run. A clean exit (an RCON stop, a loader
 * exiting 0 after a startup crash) is only "Consumed ... CPU time" on some
 * systemd versions, without "Deactivated successfully": those runs never
 * ended, and such startup crashes were never counted.
 */
const isEnd = (m: string) => /^Stopped |Main process exited|Deactivated successfully|Failed with result|service: Consumed /.test(m);
const isDone = (m: string) => /\]: Done \(/.test(m);

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

/** Records how a run ended, and whether that was a crash; called for each of systemd's end lines. */
function endRun(instanceId: string, invocation: string, at: number, message: string): void {
	const where = and(eq(serverRuns.instanceId, instanceId), eq(serverRuns.invocation, invocation));
	const run = db.select().from(serverRuns).where(where).get();
	if (!run) return;
	const status = message.match(/Main process exited, code=\w+, status=(\d+)/);
	const exitStatus = status ? Number(status[1]) : run.exitStatus;
	const failed = run.failed || /Failed with result/.test(message);
	const askedToStop = exitStatus === STOPPED_ON_REQUEST;
	const crashed = !askedToStop && (failed || (exitStatus !== null && exitStatus !== 0) || run.doneAt === null);
	db.update(serverRuns).set({ endedAt: at, exitStatus, failed, crashed }).where(where).run();
}

/** Applies journal events, oldest first, to the runs and sessions tables. */
export function applyEvents(instanceId: string, events: JournalEvent[]): void {
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
			db.update(serverRuns)
				.set({ doneAt: e.at })
				.where(and(eq(serverRuns.instanceId, instanceId), eq(serverRuns.invocation, e.invocation), isNull(serverRuns.doneAt)))
				.run();
			continue;
		}
		if (isEnd(e.message)) {
			if (e.invocation) endRun(instanceId, e.invocation, e.at, e.message);
			closeSessions(instanceId, e.at);
			continue;
		}
		const player = playerEventWithName(e.message);
		if (player?.event === 'join') {
			const open = db
				.select({ id: playerSessions.id })
				.from(playerSessions)
				.where(and(eq(playerSessions.instanceId, instanceId), eq(playerSessions.player, player.name), isNull(playerSessions.leftAt)))
				.get();
			if (!open) db.insert(playerSessions).values({ instanceId, player: player.name, joinedAt: e.at }).run();
		} else if (player?.event === 'leave') {
			closeSessions(instanceId, e.at, player.name);
		}
	}
}

/** Reads one server's new journal entries and records them. */
export async function recordHistory(instance: ServerInstance): Promise<void> {
	const { events, cursor } = await readJournalEvents(instance.id, PATTERN, {
		afterCursor: instance.historyCursor,
		since: instance.createdAt
	});
	db.transaction(() => {
		applyEvents(instance.id, events);
		if (cursor !== instance.historyCursor) {
			db.update(serverInstances).set({ historyCursor: cursor }).where(eq(serverInstances.id, instance.id)).run();
		}
	});
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
		const found = await diagnoseRun(await readRun(run.invocation, instance.createdAt), modsDir(instance.path)).catch(() => []);
		const cause = (found.find((d) => d.fatal) ?? found[0])?.title ?? null;
		db.update(serverRuns).set({ cause, diagnosed: true }).where(eq(serverRuns.id, run.id)).run();
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

export type StartTimes = { lastMs: number; lastAt: number; usualMs: number | null; runs: number };

/** How long the newest start took to reach "Done (", against the usual (median of the five before). */
export function startTimes(instanceId: string): StartTimes | null {
	const runs = db
		.select()
		.from(serverRuns)
		.where(and(eq(serverRuns.instanceId, instanceId), isNotNull(serverRuns.doneAt), eq(serverRuns.bisect, false)))
		.orderBy(desc(serverRuns.startedAt))
		.limit(6)
		.all();
	if (!runs.length) return null;
	const took = (r: (typeof runs)[number]) => r.doneAt! - r.startedAt;
	const before = runs.slice(1).map(took).sort((a, b) => a - b);
	return {
		lastMs: took(runs[0]),
		lastAt: runs[0].startedAt,
		usualMs: before.length >= 2 ? before[Math.floor(before.length / 2)] : null,
		runs: runs.length
	};
}

export type CrashRecord = { invocation: string; at: number; cause: string | null; diagnosed: boolean };

/** The server's crashes since `since`, newest first. */
export function recentCrashes(instanceId: string, since = Date.now() - 30 * 24 * 3600_000, limit = 10): CrashRecord[] {
	return db
		.select()
		.from(serverRuns)
		.where(
			and(eq(serverRuns.instanceId, instanceId), eq(serverRuns.crashed, true), eq(serverRuns.bisect, false), gt(serverRuns.startedAt, since))
		)
		.orderBy(desc(serverRuns.startedAt))
		.limit(limit)
		.all()
		.map((r) => ({ invocation: r.invocation, at: r.endedAt ?? r.startedAt, cause: r.cause, diagnosed: r.diagnosed }));
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
