/**
 * A server's snapshot schedule as stored and as its forms post it, apart from snapshotschedule.ts
 * (which runs it) so the new-server defaults can hold one without importing the scheduler.
 */

export type SnapshotSchedule = {
	every: 'off' | 'daily' | 'interval';
	/** HH:MM, local time, for 'daily'. */
	dailyTime: string;
	/** For 'interval'. */
	intervalHours: number;
	/** What happens to a running server. */
	whileRunning: 'live' | 'stop';
	/** Warnings before a stop (stop mode), in minutes; 0 for none. */
	warnMinutes: number;
	/** Skip a slot when nobody was online since the last full snapshot. */
	skipIdle: boolean;
};

/** What a server without a stored schedule has: none. Existing servers keep this. */
export const DEFAULT_SCHEDULE: SnapshotSchedule = { every: 'off', dailyTime: '04:00', intervalHours: 24, whileRunning: 'live', warnMinutes: 5, skipIdle: true };

/**
 * What a new server starts with unless New server defaults say otherwise: a snapshot each day
 * at 4:00 while it runs, skipped when nobody played since the last one. Without it a new
 * server had no copies of its world but those taken before changes.
 */
export const NEW_SERVER_SCHEDULE: SnapshotSchedule = { ...DEFAULT_SCHEDULE, every: 'daily' };

/** Anything stored or sent, made into a schedule: unknown or out-of-range values fall back. */
export function validSchedule(raw: Record<string, unknown>): SnapshotSchedule {
	const time = typeof raw.dailyTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.dailyTime) ? raw.dailyTime : DEFAULT_SCHEDULE.dailyTime;
	const hours = Number(raw.intervalHours);
	const warn = Number(raw.warnMinutes);
	return {
		every: raw.every === 'daily' || raw.every === 'interval' ? raw.every : 'off',
		dailyTime: time,
		intervalHours: Number.isInteger(hours) && hours >= 1 && hours <= 24 * 7 ? hours : DEFAULT_SCHEDULE.intervalHours,
		whileRunning: raw.whileRunning === 'stop' ? 'stop' : 'live',
		warnMinutes: Number.isInteger(warn) && warn >= 0 && warn <= 15 ? warn : DEFAULT_SCHEDULE.warnMinutes,
		skipIdle: raw.skipIdle !== false
	};
}

/** The schedule fields as SnapshotScheduleFields posts them (a switch is absent when off). */
export function scheduleFromForm(form: FormData): SnapshotSchedule {
	return validSchedule({
		every: form.get('snapshotEvery'),
		dailyTime: form.get('snapshotDailyTime'),
		intervalHours: Number(form.get('snapshotIntervalHours')),
		whileRunning: form.get('snapshotWhileRunning'),
		warnMinutes: Number(form.get('snapshotWarnMinutes')),
		skipIdle: form.get('snapshotSkipIdle') === 'on'
	});
}
