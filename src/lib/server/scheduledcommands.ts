import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { listOperations } from './operations';
import { scheduledCommands, type ScheduledCommand, type ServerInstance } from './db/schema';
import { audit, getInstance, rconPassword } from './instances';
import { rconExec } from './rcon';
import { unitState } from './systemd';
import { clockSlot } from './snapshotschedule';

/**
 * Console commands on a schedule - an announcement every hour, a save-all
 * at 4:00 - run over RCON by the scheduler's tick (scheduler.ts). Only while
 * the server runs: a stopped server's commands roll forward to their next
 * slot instead of firing in a burst when it starts.
 */

export type CommandSchedule = { everyMinutes: number } | { dailyTime: string };

/**
 * The next slot after `from` for "every N minutes", on the clock as restarts and
 * snapshots are: whole hours as clockSlot, minutes that divide a day at the
 * multiples of N since midnight (every 15: :00, :15, :30, :45); anything else,
 * N minutes on.
 */
export function minuteSlot(minutes: number, from: number): number {
	if (minutes % 60 === 0) return clockSlot(minutes / 60, from);
	if (1440 % minutes !== 0) return from + minutes * 60_000;
	const next = new Date(from);
	const sinceMidnight = next.getHours() * 60 + next.getMinutes();
	next.setHours(0, (Math.floor(sinceMidnight / minutes) + 1) * minutes, 0, 0);
	return next.getTime();
}

export function nextRunAt(schedule: { everyMinutes: number | null; dailyTime: string | null }, from = Date.now()): number | null {
	if (schedule.everyMinutes && schedule.everyMinutes > 0) return minuteSlot(schedule.everyMinutes, from);
	if (schedule.dailyTime) {
		const [hour, minute] = schedule.dailyTime.split(':').map(Number);
		if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
		const next = new Date(from);
		next.setSeconds(0, 0);
		next.setHours(hour, minute);
		if (next.getTime() <= from) next.setDate(next.getDate() + 1);
		return next.getTime();
	}
	return null;
}

/** A console command as typed, without the slash the in-game chat needs. */
export function cleanCommand(raw: string): string {
	return raw.trim().replace(/^\//, '').replace(/[\r\n]+/g, ' ');
}

export function listScheduledCommands(instanceId: string): ScheduledCommand[] {
	return db.select().from(scheduledCommands).where(eq(scheduledCommands.instanceId, instanceId)).orderBy(scheduledCommands.id).all();
}

export function addScheduledCommand(instanceId: string, command: string, schedule: CommandSchedule): ScheduledCommand {
	const everyMinutes = 'everyMinutes' in schedule ? schedule.everyMinutes : null;
	const dailyTime = 'dailyTime' in schedule ? schedule.dailyTime : null;
	return db
		.insert(scheduledCommands)
		.values({
			instanceId,
			command: cleanCommand(command),
			everyMinutes,
			dailyTime,
			nextAt: nextRunAt({ everyMinutes, dailyTime }),
			createdAt: Date.now()
		})
		.returning()
		.get();
}

export function removeScheduledCommand(instanceId: string, id: number): void {
	db.delete(scheduledCommands).where(and(eq(scheduledCommands.id, id), eq(scheduledCommands.instanceId, instanceId))).run();
}

export function setScheduledCommandEnabled(instanceId: string, id: number, enabled: boolean): void {
	const row = db.select().from(scheduledCommands).where(and(eq(scheduledCommands.id, id), eq(scheduledCommands.instanceId, instanceId))).get();
	if (!row) return;
	db.update(scheduledCommands)
		// Re-enabling starts from now, not from a slot that passed while it was off.
		.set({ enabled, nextAt: enabled ? nextRunAt(row) : row.nextAt })
		.where(eq(scheduledCommands.id, id))
		.run();
}

async function runOne(instance: ServerInstance, row: ScheduledCommand, now: number): Promise<void> {
	const password = rconPassword(instance);
	let result: string;
	try {
		if (!password) throw new Error('RCON is not set up');
		const [answer] = await rconExec({ port: instance.rconPort, password }, [row.command]);
		result = (answer ?? '').trim().slice(0, 300) || 'OK';
		audit('scheduler.command', { instanceId: instance.id, detail: row.command.slice(0, 200), actor: 'scheduler' });
	} catch (err) {
		result = `Failed: ${err instanceof Error ? err.message : 'unknown error'}`;
	}
	db.update(scheduledCommands)
		.set({ lastRunAt: now, lastResult: result, nextAt: nextRunAt(row, now) })
		.where(eq(scheduledCommands.id, row.id))
		.run();
}

/**
 * At startup: slots that passed while MineShell was down move on instead of all
 * firing at once, and intervals set before they fell on the clock move onto it.
 */
export function rollForwardMissed(now = Date.now()): void {
	for (const row of db.select().from(scheduledCommands).all()) {
		if (row.nextAt === null) continue;
		const offClock = row.everyMinutes !== null && minuteSlot(row.everyMinutes, row.nextAt - 1) !== row.nextAt;
		if (row.nextAt < now || offClock) {
			db.update(scheduledCommands).set({ nextAt: nextRunAt(row, now) }).where(eq(scheduledCommands.id, row.id)).run();
		}
	}
}

/** Run what is due; called on every scheduler tick. */
export async function runDueCommands(now = Date.now()): Promise<void> {
	const due = db
		.select()
		.from(scheduledCommands)
		.where(eq(scheduledCommands.enabled, true))
		.all()
		.filter((row) => row.nextAt !== null && row.nextAt <= now);
	for (const row of due) {
		const instance = getInstance(row.instanceId);
		if (!instance) continue;
		const state = await unitState(instance.id);
		// Not into the mod bisect assistant's test runs (a scheduled "stop" would end one early).
		const bisecting = listOperations().some((o) => o.instanceId === instance.id && o.journal.kind === 'bisect');
		if (state.active !== 'active' || bisecting) {
			db.update(scheduledCommands).set({ nextAt: nextRunAt(row, now) }).where(eq(scheduledCommands.id, row.id)).run();
			continue;
		}
		await runOne(instance, row, now);
	}
}

/** The schedules of `from`, copied to a cloned server. */
export function copyScheduledCommands(fromId: string, toId: string): void {
	for (const { id: _id, instanceId: _instance, lastRunAt: _last, lastResult: _result, ...row } of listScheduledCommands(fromId)) {
		db.insert(scheduledCommands).values({ ...row, instanceId: toId, nextAt: nextRunAt(row), createdAt: Date.now() }).run();
	}
}
