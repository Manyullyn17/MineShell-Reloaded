import { and, eq, gte, isNotNull, lte } from 'drizzle-orm';
import { db } from './db';
import { serverRuns } from './db/schema';
import { doneLoggedSince } from './journal';

/**
 * Whether a running server has finished starting: systemd calls a unit
 * active as soon as Java runs, but players can join only once the server
 * logged "Done (" - a big pack takes minutes to get there.
 */

/** Runs (by start time) seen to finish starting, per server: when they did. */
const finished = new Map<string, { startedAt: number; doneAt: number }>();
/** Runs last seen still starting, per server, and when that was looked up. */
const notYet = new Map<string, { startedAt: number; checkedAt: number }>();
/** How long "still starting" is believed before the journal is read again (pages poll every few seconds). */
const RECHECK_MS = 2000;

/**
 * When the run systemd started at `startedAt` logged "Done (", or null while
 * it is still starting. The run history (read every 30 s) answers first; the
 * journal covers the time before it catches up.
 */
export async function doneStartingAt(instanceId: string, createdAt: number, startedAt: number, now = Date.now()): Promise<number | null> {
	if (!startedAt) return null;
	const known = finished.get(instanceId);
	if (known?.startedAt === startedAt) return known.doneAt;
	const pending = notYet.get(instanceId);
	if (pending?.startedAt === startedAt && now - pending.checkedAt < RECHECK_MS) return null;

	// The history's start is systemd's "Started" line, a moment off the unit's own timestamp.
	const run = db
		.select({ doneAt: serverRuns.doneAt })
		.from(serverRuns)
		.where(
			and(
				eq(serverRuns.instanceId, instanceId),
				gte(serverRuns.startedAt, startedAt - 10_000),
				lte(serverRuns.startedAt, startedAt + 10_000),
				isNotNull(serverRuns.doneAt)
			)
		)
		.get();
	const doneAt = run?.doneAt ?? (await doneLoggedSince(instanceId, Math.max(createdAt, startedAt)));
	if (doneAt === null) {
		notYet.set(instanceId, { startedAt, checkedAt: now });
		return null;
	}
	finished.set(instanceId, { startedAt, doneAt });
	notYet.delete(instanceId);
	return doneAt;
}
