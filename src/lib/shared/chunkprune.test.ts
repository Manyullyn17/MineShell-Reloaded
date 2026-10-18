import { describe, expect, it } from 'vitest';
import { decodeAnalysis, encodeAnalysis, formatTicks, heatStep, keptBySpawn, NO_CHUNK, prunes, UNREADABLE } from './chunkprune';

describe('chunk pruning rules', () => {
	it('keeps a chunk any part of which is within the spawn radius', () => {
		const keep = { x: 0, z: 0, radius: 64 };
		expect(keptBySpawn(keep, -1, -1)).toBe(true);
		expect(keptBySpawn(keep, 4, 0)).toBe(true); // x 64-79: its edge is on the circle
		expect(keptBySpawn(keep, 5, 0)).toBe(false);
		expect(keptBySpawn({ ...keep, radius: 0 }, 0, 0)).toBe(false);
	});

	it('prunes under the threshold, never an unreadable chunk', () => {
		const rule = { maxTicks: 1200, keep: null };
		expect(prunes(1199, 9, 9, rule)).toBe(true);
		expect(prunes(1200, 9, 9, rule)).toBe(false);
		expect(prunes(null, 9, 9, rule)).toBe(false);
	});

	it('puts times into heat steps and words', () => {
		expect([0, 1, 1199, 1200, 5999, 36000, 144000, 720000].map(heatStep)).toEqual([1, 2, 2, 3, 3, 5, 6, 7]);
		expect([0, 400, 1300, 80000].map(formatTicks)).toEqual(['0 s', '20 s', '1 min 5 s', '1 h 6 min']);
	});

	it('sends an analysis whole', () => {
		const ticks = new Uint32Array(1024).fill(NO_CHUNK);
		ticks[0] = 5;
		ticks[1023] = UNREADABLE;
		const sectors = new Uint16Array(1024);
		sectors[0] = 3;
		const other = { x: 1, z: 2, ticks: new Uint32Array(1024).fill(9), sectors: new Uint16Array(1024).fill(1) };
		// A name whose UTF-8 is longer than its characters must not shift the arrays.
		const head = { dimension: 'wörld/region', at: 42, spawn: { x: 1, z: -2 }, regions: [{ x: -1, z: 0 }, { x: 1, z: 2 }] };
		const bytes = encodeAnalysis(head, [{ x: -1, z: 0, ticks, sectors }, other]);
		const back = decodeAnalysis(bytes.buffer.slice(0) as ArrayBuffer);
		expect(back.head).toEqual(head);
		expect(back.regions[0]).toEqual({ x: -1, z: 0, ticks, sectors });
		expect(back.regions[1]).toEqual(other);
	});
});
