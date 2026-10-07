import { and, desc, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';
import { db } from './db';
import { playerSessions, serverInstances, serverRuns, type ServerInstance } from './db/schema';
import { readJournalEvents, type JournalEvent } from './journal';
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
 */

const POLL_MS = 30_000;
const PATTERN =
	'joined the game$|left the game$|lost connection: |\\]: Done \\(|^Started |^Stopped |Main process exited|Deactivated successfully|Failed with result';

const isStart = (m: string) => /^Started /.test(m);
const isEnd = (m: string) => /^Stopped |Main process exited|Deactivated successfully|Failed with result/.test(m);
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

/** Applies journal events, oldest first, to the runs and sessions tables. */
export function applyEvents(instanceId: string, events: JournalEvent[]): void {
	for (const e of events) {
		if (isStart(e.message) && e.invocation) {
			// A run that ended without its stop being logged (killed, power cut) leaves sessions open.
			closeSessions(instanceId, e.at);
			db.insert(serverRuns)
				.values({ instanceId, invocation: e.invocation, startedAt: e.at })
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
			if (e.invocation) {
				db.update(serverRuns)
					.set({ endedAt: e.at })
					.where(and(eq(serverRuns.instanceId, instanceId), eq(serverRuns.invocation, e.invocation)))
					.run();
			}
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
		.where(and(eq(serverRuns.instanceId, instanceId), isNotNull(serverRuns.doneAt)))
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

/** Start time per run, by invocation id, for the Logs tab's run list. */
export function startTimesByRun(instanceId: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const r of db.select().from(serverRuns).where(and(eq(serverRuns.instanceId, instanceId), isNotNull(serverRuns.doneAt))).all()) {
		out[r.invocation] = r.doneAt! - r.startedAt;
	}
	return out;
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
