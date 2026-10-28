import { describe, expect, it } from 'vitest';
import type { ServerInstance } from './db/schema';
import { computeNextRun, describeSchedule } from './scheduler';

const instance = (o: Partial<ServerInstance>) =>
	({ restartSchedule: 'none', restartIntervalHours: null, restartDailyTime: null, ...o }) as ServerInstance;

// Local time on purpose: daily restarts are wall-clock times on the server.
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

describe('computeNextRun', () => {
	it('goes back to a daily time the spring clock change skipped the day after', () => {
		const tz = process.env.TZ;
		process.env.TZ = 'Europe/Vienna';
		try {
			const daily = instance({ restartSchedule: 'daily', restartDailyTime: '02:30' });
			let at = Date.parse('2026-03-28T12:00:00+01:00');
			const runs: string[] = [];
			for (let i = 0; i < 3; i++) {
				at = computeNextRun(daily, at)!;
				const d = new Date(at);
				runs.push(`${d.getDate()} ${d.getHours()}:${d.getMinutes()}`);
			}
			// 02:30 does not exist on the 29th; the 30th kept its 03:30 before the fix.
			expect(runs).toEqual(['29 3:30', '30 2:30', '31 2:30']);
			// Autumn: 02:30 comes twice and runs once.
			const first = computeNextRun(daily, Date.parse('2026-10-25T00:00:00+02:00'))!;
			expect(computeNextRun(daily, first)).toBe(Date.parse('2026-10-26T02:30:00+01:00'));
		} finally {
			process.env.TZ = tz;
		}
	});

	it('is off unless a schedule is set', () => {
		expect(computeNextRun(instance({}), at(2026, 1, 1, 12, 0))).toBeNull();
	});

	it('puts an interval on the clock', () => {
		const from = at(2026, 1, 1, 12, 0);
		expect(computeNextRun(instance({ restartSchedule: 'interval', restartIntervalHours: 6 }), from)).toBe(at(2026, 1, 1, 18, 0));
		// Not 19:30: every 6 hours is 0:00, 6:00, 12:00, 18:00.
		expect(computeNextRun(instance({ restartSchedule: 'interval', restartIntervalHours: 6 }), at(2026, 1, 1, 13, 30))).toBe(at(2026, 1, 1, 18, 0));
		expect(computeNextRun(instance({ restartSchedule: 'interval', restartIntervalHours: 0 }), from)).toBeNull();
	});

	it('picks today for a later daily time and tomorrow once it has passed', () => {
		const daily = instance({ restartSchedule: 'daily', restartDailyTime: '05:30' });
		expect(computeNextRun(daily, at(2026, 1, 1, 4, 0))).toBe(at(2026, 1, 1, 5, 30));
		expect(computeNextRun(daily, at(2026, 1, 1, 5, 30))).toBe(at(2026, 1, 2, 5, 30));
		expect(computeNextRun(daily, at(2026, 12, 31, 23, 0))).toBe(at(2027, 1, 1, 5, 30));
	});

	it('rejects a malformed daily time', () => {
		expect(computeNextRun(instance({ restartSchedule: 'daily', restartDailyTime: 'soon' }), at(2026, 1, 1, 4, 0))).toBeNull();
	});
});

describe('describeSchedule', () => {
	it('describes each mode', () => {
		expect(describeSchedule(instance({}))).toBe('Off');
		expect(describeSchedule(instance({ restartSchedule: 'interval', restartIntervalHours: 4 }))).toBe('Every 4 hours');
		expect(describeSchedule(instance({ restartSchedule: 'daily', restartDailyTime: '03:15' }))).toBe('Daily at 03:15');
	});
});
