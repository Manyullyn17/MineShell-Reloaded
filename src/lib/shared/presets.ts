/**
 * The fixed choices some fields offer instead of a free number, because the
 * code only acts on these values or because others come out uneven.
 */

export type Preset = { value: number; label: string };

/**
 * "Every N hours" falls on the clock (snapshotschedule.ts, clockSlot): up to a day,
 * the hours that are multiples of N, so only divisors of 24 come out even
 * (every 5: 0, 5, 10, 15, 20, then 0 again); whole days count from a fixed day.
 */
export const EVERY_HOURS: Preset[] = [
	{ value: 1, label: 'Every hour' },
	{ value: 2, label: 'Every 2 hours' },
	{ value: 3, label: 'Every 3 hours' },
	{ value: 4, label: 'Every 4 hours' },
	{ value: 6, label: 'Every 6 hours' },
	{ value: 8, label: 'Every 8 hours' },
	{ value: 12, label: 'Every 12 hours' },
	{ value: 24, label: 'Every day' },
	{ value: 48, label: 'Every 2 days' },
	{ value: 168, label: 'Every week' }
];
export const unevenHours = (hours: number) => `Every ${hours} hours (uneven)`;

/** In-game warnings go out at these minutes before (scheduler.ts, snapshotschedule.ts). */
export const WARN_MARKS = [15, 10, 5, 1];
export const WARN_CHOICES = [
	{ value: '0', label: 'Off' },
	{ value: '1', label: '1 min' },
	{ value: '5', label: '5 min' },
	{ value: '10', label: '10 min' },
	{ value: '15', label: '15 min' }
] as const;
/** What a stored warning window sends from: 7 minutes warns at 5 and 1, as 5 does. */
export function warnChoice(minutes: number | null | undefined): '0' | '1' | '5' | '10' | '15' {
	const mark = WARN_MARKS.find((m) => m <= (minutes ?? 0));
	return String(mark ?? 0) as '0' | '1' | '5' | '10' | '15';
}

/** Crash restarts are counted over this window (systemd StartLimitIntervalSec), in seconds. */
export const CRASH_WINDOWS: Preset[] = [
	{ value: 60, label: '1 minute' },
	{ value: 300, label: '5 minutes' },
	{ value: 600, label: '10 minutes' },
	{ value: 1800, label: '30 minutes' },
	{ value: 3600, label: '1 hour' },
	{ value: 21600, label: '6 hours' },
	{ value: 86400, label: '1 day' }
];
export function windowLabel(seconds: number): string {
	if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
	if (seconds % 60 === 0) return `${seconds / 60} minutes`;
	return `${seconds} seconds`;
}
