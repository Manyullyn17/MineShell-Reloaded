import { describe, expect, it } from 'vitest';
import { adviseMemory, neededHeap } from './memoryadvice';

const GB = 1024 ** 3;
const HOUR = 3_600_000;
const T0 = Math.floor(Date.UTC(2026, 9, 1) / HOUR) * HOUR;

/** A G1 sawtooth: once a minute for `hours`, rising from `floor` to `peak` GB and collected back. */
function sawtooth(hours: number, floor: number, peak: number, maxGb: number) {
	const out = [];
	for (let m = 0; m < hours * 60; m++) {
		const phase = (m % 10) / 9;
		out.push({ timestamp: T0 + m * 60_000, usedBytes: Math.round((floor + (peak - floor) * phase) * GB), maxBytes: maxGb * GB });
	}
	return out;
}

/** Players online the whole time. */
const ALWAYS: [number, number][] = [[T0, T0 + 1000 * HOUR]];

describe('memory advice', () => {
	it('takes what is left after collections, not the peak, as what a server needs', () => {
		const heap = neededHeap(sawtooth(8, 3, 14, 16))!;
		expect(heap).toMatchObject({ neededMb: 3 * 1024, heapMaxMb: 16 * 1024, hours: 8 });
	});

	it('says nothing from samples until there are six hours of them', () => {
		expect(adviseMemory({ samples: sawtooth(5, 1, 14, 16), currentMb: 16384, played: ALWAYS, oomAt: null, totalRamMb: 64 * 1024 })).toEqual({ kind: 'unknown', currentMb: 16384, hours: 5, playedHours: 5, playedDays: 1 });
	});

	it('suggests less for a heap far bigger than it needs, in whole gigabytes', () => {
		expect(adviseMemory({ samples: sawtooth(72, 1.6, 14, 16), currentMb: 16384, played: ALWAYS, oomAt: null, totalRamMb: 64 * 1024 })).toMatchObject({ kind: 'less', suggestedMb: 5 * 1024, neededMb: 1638 });
		// A healthy heap with a G1 sawtooth up to its maximum is fine.
		expect(adviseMemory({ samples: sawtooth(72, 4, 15.5, 16), currentMb: 16384, played: ALWAYS, oomAt: null, totalRamMb: 64 * 1024 })).toMatchObject({ kind: 'ok', neededMb: 4096 });
	});

	it('suggests more when even after collections the heap is mostly full, as far as the machine allows', () => {
		expect(adviseMemory({ samples: sawtooth(8, 3.4, 3.9, 4), currentMb: 4096, played: ALWAYS, oomAt: null, totalRamMb: 32 * 1024 })).toMatchObject({ kind: 'more', reason: 'full', suggestedMb: 11 * 1024 });
		expect(adviseMemory({ samples: sawtooth(8, 3.4, 3.9, 4), currentMb: 4096, played: ALWAYS, oomAt: null, totalRamMb: 8 * 1024 })).toMatchObject({ kind: 'more', suggestedMb: 6 * 1024 });
		expect(adviseMemory({ samples: sawtooth(8, 3.4, 3.9, 4), currentMb: 4096, played: ALWAYS, oomAt: null, totalRamMb: 6 * 1024 })).toMatchObject({ kind: 'more', suggestedMb: null });
	});

	it('suggests more after an out-of-memory crash, samples or not', () => {
		expect(adviseMemory({ samples: [], currentMb: 6144, played: [], oomAt: T0, totalRamMb: 32 * 1024 })).toMatchObject({ kind: 'more', reason: 'out-of-memory', suggestedMb: 9 * 1024, oomAt: T0 });
	});

	it('suggests less only from hours with players online: an idle server says nothing about a busy one', () => {
		// 2 GB of 10 while empty for days, players on for two of the hours.
		const idle = sawtooth(96, 2, 9, 10);
		const twoHours: [number, number][] = [[T0 + 30 * HOUR, T0 + 32 * HOUR]];
		expect(adviseMemory({ samples: idle, played: [], currentMb: 10240, oomAt: null, totalRamMb: 64 * 1024 })).toEqual({
			kind: 'unknown',
			currentMb: 10240,
			hours: 96,
			playedHours: 0,
			playedDays: 0
		});
		expect(adviseMemory({ samples: idle, played: twoHours, currentMb: 10240, oomAt: null, totalRamMb: 64 * 1024 })).toMatchObject({ kind: 'unknown', playedHours: 2 });

		// Two hours on each of three days.
		const sixHours: [number, number][] = [30, 54, 78].map((h): [number, number] => [T0 + h * HOUR, T0 + (h + 2) * HOUR]);
		const during = (t: number) => sixHours.some(([start, end]) => t >= start && t < end);
		// The same server holding 7.5 GB even after collections with players on: short, not oversized.
		const busy = idle.map((s) => (during(s.timestamp) ? { ...s, usedBytes: Math.max(s.usedBytes, 7.5 * GB) } : s));
		expect(adviseMemory({ samples: busy, played: sixHours, currentMb: 10240, oomAt: null, totalRamMb: 64 * 1024 })).toMatchObject({ kind: 'more', reason: 'full' });
		// 2 GB with players on too: judged from those hours (10 GB is not five times 2, so fine), and far more is too much.
		expect(adviseMemory({ samples: idle, played: sixHours, currentMb: 10240, oomAt: null, totalRamMb: 64 * 1024 })).toMatchObject({ kind: 'ok', neededMb: 2048 });
		expect(adviseMemory({ samples: sawtooth(96, 1.5, 9, 16), played: sixHours, currentMb: 16384, oomAt: null, totalRamMb: 64 * 1024 })).toMatchObject({ kind: 'less', suggestedMb: 5 * 1024 });
	});

	it('counts minutes played, not clock hours touched, and wants play on three days', () => {
		const samples = sawtooth(120, 0.7, 6, 8);
		// Days are local: sessions start from local midnight on 2 October, whatever the time zone.
		const day0 = new Date(2026, 9, 2).getTime();
		const at = (h: number, minutes: number): [number, number] => [day0 + h * HOUR, day0 + h * HOUR + minutes * 60_000];
		// Irithyll on prod: 42, 23 and 37 minutes on two days used to pass for three played hours and suggested less.
		const shortSessions = [at(9, 42), at(16, 23), at(40, 37)];
		expect(adviseMemory({ samples, played: shortSessions, currentMb: 8192, oomAt: null, totalRamMb: 64 * 1024 })).toMatchObject({ kind: 'unknown', playedHours: 1.7, playedDays: 2 });
		// Six hours, but on two days.
		const twoDays = [at(10, 180), at(34, 180)];
		expect(adviseMemory({ samples, played: twoDays, currentMb: 8192, oomAt: null, totalRamMb: 64 * 1024 })).toMatchObject({ kind: 'unknown', playedHours: 6, playedDays: 2 });
		// Three days, but under five hours.
		const shortDays = [at(10, 60), at(34, 60), at(58, 60)];
		expect(adviseMemory({ samples, played: shortDays, currentMb: 8192, oomAt: null, totalRamMb: 64 * 1024 })).toMatchObject({ kind: 'unknown', playedHours: 3, playedDays: 3 });
		// A minute's login does not make a day.
		const loginDay = [at(10, 180), at(34, 150), at(58, 1)];
		expect(adviseMemory({ samples, played: loginDay, currentMb: 8192, oomAt: null, totalRamMb: 64 * 1024 })).toMatchObject({ kind: 'unknown', playedDays: 2 });
		// Enough of both.
		const enough = [at(10, 120), at(34, 120), at(58, 90)];
		expect(adviseMemory({ samples, played: enough, currentMb: 8192, oomAt: null, totalRamMb: 64 * 1024 })).toMatchObject({ kind: 'less', suggestedMb: 3 * 1024 });
	});

	it('still says short on memory from idle hours', () => {
		expect(adviseMemory({ samples: sawtooth(8, 3.4, 3.9, 4), played: [], currentMb: 4096, oomAt: null, totalRamMb: 32 * 1024 })).toMatchObject({ kind: 'more', reason: 'full' });
	});
});
