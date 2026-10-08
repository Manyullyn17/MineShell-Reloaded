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

describe('memory advice', () => {
	it('takes what is left after collections, not the peak, as what a server needs', () => {
		const heap = neededHeap(sawtooth(8, 3, 14, 16))!;
		expect(heap).toMatchObject({ neededMb: 3 * 1024, heapMaxMb: 16 * 1024, hours: 8 });
	});

	it('says nothing from samples until there are six hours of them', () => {
		expect(adviseMemory({ samples: sawtooth(5, 1, 14, 16), currentMb: 16384, oomAt: null, totalRamMb: 64 * 1024 })).toEqual({ kind: 'unknown', currentMb: 16384, hours: 5 });
	});

	it('suggests less for a heap far bigger than it needs, in whole gigabytes', () => {
		expect(adviseMemory({ samples: sawtooth(8, 1.6, 14, 16), currentMb: 16384, oomAt: null, totalRamMb: 64 * 1024 })).toMatchObject({ kind: 'less', suggestedMb: 5 * 1024, neededMb: 1638 });
		// A healthy heap with a G1 sawtooth up to its maximum is fine.
		expect(adviseMemory({ samples: sawtooth(8, 4, 15.5, 16), currentMb: 16384, oomAt: null, totalRamMb: 64 * 1024 })).toMatchObject({ kind: 'ok', neededMb: 4096 });
	});

	it('suggests more when even after collections the heap is mostly full, as far as the machine allows', () => {
		expect(adviseMemory({ samples: sawtooth(8, 3.4, 3.9, 4), currentMb: 4096, oomAt: null, totalRamMb: 32 * 1024 })).toMatchObject({ kind: 'more', reason: 'full', suggestedMb: 11 * 1024 });
		expect(adviseMemory({ samples: sawtooth(8, 3.4, 3.9, 4), currentMb: 4096, oomAt: null, totalRamMb: 8 * 1024 })).toMatchObject({ kind: 'more', suggestedMb: 6 * 1024 });
		expect(adviseMemory({ samples: sawtooth(8, 3.4, 3.9, 4), currentMb: 4096, oomAt: null, totalRamMb: 6 * 1024 })).toMatchObject({ kind: 'more', suggestedMb: null });
	});

	it('suggests more after an out-of-memory crash, samples or not', () => {
		expect(adviseMemory({ samples: [], currentMb: 6144, oomAt: T0, totalRamMb: 32 * 1024 })).toMatchObject({ kind: 'more', reason: 'out-of-memory', suggestedMb: 9 * 1024, oomAt: T0 });
	});
});
