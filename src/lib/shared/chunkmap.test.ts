import { describe, expect, it } from 'vitest';
import { busiestRegion } from './chunkmap';

/** An overview entry with `n` chunks present. */
const region = (x: number, z: number, n: number) => {
	const bits = new Uint8Array(128);
	for (let i = 0; i < n; i++) bits[i >> 3] |= 1 << (i & 7);
	return { x, z, chunks: btoa(String.fromCharCode(...bits)) };
};

describe('where a dimension opens', () => {
	it('at the middle of the region with the most chunks, not at a nearly empty one by 0,0', () => {
		// MeatballCraft's Deep Dark: two chunks in r.0.0, the bulk around r.-4.-3.
		expect(busiestRegion([region(0, 0, 2), region(-4, -3, 900), region(-5, -3, 400)])).toEqual({ x: -1792, z: -1280 });
		expect(busiestRegion([])).toBeNull();
	});
});
