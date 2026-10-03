import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { scheduledCommands, type ScheduledCommand, type ServerInstance } from './db/schema';
import { audit, getInstance, rconPassword } from './instances';
import { rconExec } from './rcon';
import { unitState } from './systemd';

/**
 * Console commands on a schedule - an announcement every hour, a save-all
 * at 4:00 - run over RCON by the scheduler's tick (scheduler.ts). Only while
 * the server runs: a stopped server's commands roll forward to their next
 * slot instead of firing in a burst when it starts.
 */

export type CommandSchedule = { everyMinutes: number } | { dailyTime: string };

export function nextRunAt(schedule: { everyMinutes: number | null; dailyTime: string | null }, from = Date.now()): number | null {
	if (schedule.everyMinutes && schedule.everyMinutes > 0) return from + schedule.everyMinutes * 60_000;
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

/** At startup: slots that passed while MineShell was down move on instead of all firing at once. */
export function rollForwardMissed(now = Date.now()): void {
	for (const row of db.select().from(scheduledCommands).all()) {
		if (row.nextAt !== null && row.nextAt < now) {
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
		if (state.active !== 'active') {
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
