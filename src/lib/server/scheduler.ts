import { eq } from 'drizzle-orm';
import { db } from './db';
import { listOperations } from './operations';
import { serverInstances, type ServerInstance } from './db/schema';
import { audit, listInstances, onlinePlayers, rconPassword, restart } from './instances';
import { rconExec } from './rcon';
import { unitState } from './systemd';
import { rollForwardMissed, runDueCommands } from './scheduledcommands';
import { autoPauseForPlayers } from './chunky';
import { evaluateSnapshotSchedule, rollForwardSnapshots } from './snapshotschedule';
import { evaluateMapSchedule, rollForwardMaps } from './worldmap';

/**
 * Scheduled restarts are application logic, not systemd timers. Two reasons:
 * the schedule needs to be editable from the UI without writing unit files, and
 * "restart at 5am unless someone is online" is a decision systemd cannot make.
 * The control path is the same as the manual restart button.
 */

const CHECK_INTERVAL_MS = 30_000;
/** How long to keep deferring when players are online before giving up for this cycle. */
const MAX_DEFER_MS = 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
/** instanceId -> timers already fired for the pending restart, so warnings are not repeated. */
const warned = new Map<string, Set<number>>();
const deferredSince = new Map<string, number>();

export function computeNextRun(instance: ServerInstance, from = Date.now()): number | null {
	if (instance.restartSchedule === 'interval') {
		const hours = instance.restartIntervalHours ?? 6;
		if (hours <= 0) return null;
		return from + hours * 60 * 60 * 1000;
	}

	if (instance.restartSchedule === 'daily') {
		const [hourStr, minuteStr] = (instance.restartDailyTime ?? '05:00').split(':');
		const hour = Number(hourStr);
		const minute = Number(minuteStr);
		if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
		const next = new Date(from);
		next.setSeconds(0, 0);
		next.setHours(hour, minute);
		if (next.getTime() <= from) next.setDate(next.getDate() + 1);
		return next.getTime();
	}

	return null;
}

/** Called whenever schedule settings change, and after each fire. */
export function rescheduleInstance(instanceId: string, from = Date.now()): void {
	const instance = db.select().from(serverInstances).where(eq(serverInstances.id, instanceId)).get();
	if (!instance) return;
	const next = computeNextRun(instance, from);
	db.update(serverInstances)
		.set({ restartNextAt: next, updatedAt: Date.now() })
		.where(eq(serverInstances.id, instanceId))
		.run();
	warned.delete(instanceId);
	deferredSince.delete(instanceId);
}

async function warnPlayers(instance: ServerInstance, minutesLeft: number): Promise<void> {
	const password = rconPassword(instance);
	if (!password) return;
	const label = minutesLeft >= 1 ? `${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}` : 'a few seconds';
	try {
		await rconExec({ port: instance.rconPort, password }, [
			`say Scheduled restart in ${label}.`
		]);
	} catch {
		/* server may be mid-boot; the restart still happens */
	}
}

async function evaluate(instance: ServerInstance): Promise<void> {
	if (instance.restartSchedule === 'none') return;

	let nextAt = instance.restartNextAt;
	if (!nextAt) {
		rescheduleInstance(instance.id);
		return;
	}

	const now = Date.now();
	const state = await unitState(instance.id);
	if (state.active !== 'active') {
		// Nothing to restart. Roll the schedule forward so it does not fire the
		// instant the server comes back up.
		if (nextAt <= now) rescheduleInstance(instance.id, now);
		return;
	}

	const warnMs = (instance.restartWarnMinutes ?? 0) * 60_000;
	const msUntil = nextAt - now;

	// In-game warnings at 15, 10, 5, 1 minutes, clipped to the configured window.
	if (warnMs > 0 && msUntil <= warnMs && msUntil > 0) {
		const marks = [15, 10, 5, 1].filter((m) => m * 60_000 <= warnMs);
		const already = warned.get(instance.id) ?? new Set<number>();
		for (const mark of marks) {
			const markMs = mark * 60_000;
			if (msUntil <= markMs && !already.has(mark)) {
				already.add(mark);
				warned.set(instance.id, already);
				await warnPlayers(instance, mark);
			}
		}
	}

	if (msUntil > 0) return;

	if (instance.restartSkipIfPlayers) {
		const players = await onlinePlayers(instance);
		if (players && players.online > 0) {
			const since = deferredSince.get(instance.id) ?? now;
			deferredSince.set(instance.id, since);
			if (now - since < MAX_DEFER_MS) {
				// Re-check in a couple of minutes rather than skipping the day.
				db.update(serverInstances)
					.set({ restartNextAt: now + 2 * 60_000 })
					.where(eq(serverInstances.id, instance.id))
					.run();
				return;
			}
			audit('scheduler.restart_forced', {
				instanceId: instance.id,
				detail: `deferred for an hour with ${players.online} online`,
				actor: 'scheduler'
			});
		}
	}

	deferredSince.delete(instance.id);
	audit('scheduler.restart', { instanceId: instance.id, actor: 'scheduler' });
	await restart(instance);
	rescheduleInstance(instance.id, Date.now());
}

async function checkAll(): Promise<void> {
	const bisecting = new Set(listOperations().filter((o) => o.journal.kind === 'bisect').map((o) => o.instanceId));
	for (const instance of listInstances()) {
		// The mod bisect assistant owns the server while it searches: no restarts or Chunky pausing.
		if (bisecting.has(instance.id)) continue;
		try {
			await evaluate(instance);
		} catch (err) {
			console.error(`[mineshell] scheduler error for ${instance.id}:`, err);
		}
		await autoPauseForPlayers(instance).catch((err) =>
			console.error(`[mineshell] Chunky auto-pause failed for ${instance.id}:`, err)
		);
		await evaluateSnapshotSchedule(instance).catch((err) =>
			console.error(`[mineshell] scheduled snapshot failed for ${instance.id}:`, err)
		);
		await evaluateMapSchedule(instance).catch((err) =>
			console.error(`[mineshell] scheduled map update failed for ${instance.id}:`, err)
		);
	}
	await runDueCommands().catch((err) => console.error('[mineshell] scheduled commands failed:', err));
}

export function startScheduler(): void {
	if (timer) return;
	// Any instance whose next run is missing or already past gets a fresh slot,
	// so a MineShell restart never causes an immediate surprise reboot.
	for (const instance of listInstances()) {
		if (instance.restartSchedule !== 'none') {
			if (!instance.restartNextAt || instance.restartNextAt < Date.now()) {
				rescheduleInstance(instance.id);
			}
		}
	}
	rollForwardMissed();
	rollForwardSnapshots();
	rollForwardMaps();
	timer = setInterval(() => void checkAll(), CHECK_INTERVAL_MS);
	timer.unref?.();
}

export function stopScheduler(): void {
	if (timer) clearInterval(timer);
	timer = null;
}

export function describeSchedule(instance: ServerInstance): string {
	if (instance.restartSchedule === 'interval') {
		return `Every ${instance.restartIntervalHours ?? 6} hours`;
	}
	if (instance.restartSchedule === 'daily') {
		return `Daily at ${instance.restartDailyTime ?? '05:00'}`;
	}
	return 'Off';
}
