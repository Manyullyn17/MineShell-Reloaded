import { describe, expect, it } from 'vitest';
import { EVERY_HOURS, warnChoice } from './presets';
import { clockSlot } from '#lib/server/snapshotschedule.js';

describe('field presets', () => {
	it('show a stored warning window as the mark it warns from', () => {
		expect(warnChoice(7)).toBe('5');
		expect(warnChoice(60)).toBe('15');
		expect(warnChoice(1)).toBe('1');
		expect(warnChoice(0)).toBe('0');
		expect(warnChoice(null)).toBe('0');
	});

	it('offer only intervals that come out even on the clock', () => {
		// Clock slots follow the wall clock (a gap across a summer time change is an
		// hour longer or shorter), so the rule is checked by local hour: a divisor of
		// 24 lands on the same hours every day, whole days always at midnight.
		const start = new Date(2026, 9, 20, 0, 0).getTime();
		for (const { value: hours } of EVERY_HOURS) {
			expect(hours <= 24 ? 24 % hours : hours % 24, `every ${hours} hours`).toBe(0);
			let at = start;
			for (let i = 0; i < 10; i++) {
				at = clockSlot(hours, at);
				const local = new Date(at);
				expect(local.getMinutes()).toBe(0);
				expect(hours <= 24 ? local.getHours() % hours : local.getHours(), `every ${hours} hours, slot ${i}`).toBe(0);
			}
		}
	});
});
