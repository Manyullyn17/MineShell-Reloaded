import { describe, expect, it } from 'vitest';
import { availableMb, ceilingMb, memoryWarning } from './memoryguard';

describe('memory check before a start', () => {
	it("counts a server as its heap plus what Java needs beyond it, capped by the server's own limit", () => {
		expect(ceilingMb(16384, null)).toBe(Math.ceil(16384 * 1.1) + 1024);
		expect(ceilingMb(16384, 18000)).toBe(18000);
	});

	it('starts quietly when the server fits beside what the running ones can still grow into', () => {
		expect(memoryWarning({ name: 'A', heapMb: 4096, needMb: 5530, availableMb: 12000, running: [{ name: 'B', ceilingMb: 12288, usedMb: 9000 }] })).toBeNull();
	});

	// The user's machine on 2026-10-15: 29 GB, irithyll (10 GB heap) half grown, MeatballCraft (16 GB) to start.
	it('warns when the running servers growing into their heaps would leave too little, naming them', () => {
		const warning = memoryWarning({
			name: 'MeatballCraft',
			heapMb: 16384,
			needMb: ceilingMb(16384, null),
			availableMb: 20000,
			running: [
				{ name: 'irithyll', ceilingMb: ceilingMb(10240, null), usedMb: 6000 },
				{ name: 'idle', ceilingMb: 3000, usedMb: 3500 }
			]
		});
		expect(warning).toContain('MeatballCraft can take up to 18.6 GB');
		expect(warning).toContain('19.5 GB is available');
		expect(warning).toContain('irithyll able to grow by');
		expect(warning).not.toContain('idle');
	});

	it('reads what is available from /proc/meminfo', async () => {
		expect(await availableMb()).toBeGreaterThan(0);
	});
});
