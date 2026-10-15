import { describe, expect, it } from 'vitest';
import { minMemoryLimitMb, suggestedMemoryLimitMb } from './memorylimit';

describe('memory limit floor', () => {
	// Resident memory outside the heap, measured on real servers (2026-10-15). Heap + 512 MB,
	// the floor before, let a limit kill either of them.
	it.each([
		['irithyll, Fabric', 10240, 890],
		['MeatballCraft, Cleanroom, after starting', 16384, 1500]
	])('leaves room for %s', (_name, heap, outside) => {
		expect(minMemoryLimitMb(heap)).toBeGreaterThan(heap + outside);
	});

	it('suggests more than the floor, in the field steps', () => {
		for (const heap of [1024, 4096, 10240, 16384]) {
			const suggested = suggestedMemoryLimitMb(heap);
			expect(suggested).toBeGreaterThanOrEqual(minMemoryLimitMb(heap));
			expect(suggested % 256).toBe(0);
		}
		// MeatballCraft a few minutes in (Dynmap rendering, a world backup): 3.3 GB outside the heap.
		expect(suggestedMemoryLimitMb(16384)).toBeGreaterThan(16384 + 3300);
	});
});
