import { describe, expect, it } from 'vitest';
import type { ServerInstance } from './db/schema';
import { computeNextRun, describeSchedule } from './scheduler';

const instance = (o: Partial<ServerInstance>) =>
	({ restartSchedule: 'none', restartIntervalHours: null, restartDailyTime: null, ...o }) as ServerInstance;

// Local time on purpose: daily restarts are wall-clock times on the server.
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

describe('computeNextRun', () => {
	it('is off unless a schedule is set', () => {
		expect(computeNextRun(instance({}), at(2026, 1, 1, 12, 0))).toBeNull();
	});

	it('adds the interval', () => {
		const from = at(2026, 1, 1, 12, 0);
		expect(computeNextRun(instance({ restartSchedule: 'interval', restartIntervalHours: 6 }), from)).toBe(at(2026, 1, 1, 18, 0));
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
