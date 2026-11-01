import { describe, expect, it } from 'vitest';
import { bucketSamples, type Sample } from './monitor';

/** A day of samples every 10 s at `cpu`, with `spike` taking over some of them. */
function day(cpu: number, spike: (i: number) => number | null): Sample[] {
	return Array.from({ length: 8640 }, (_, i) => ({ timestamp: i * 10_000, cpuPercent: spike(i) ?? cpu, memoryBytes: 1000 + (spike(i) ? 500 : 0) }));
}

describe("the performance chart's points", () => {
	it('keep a short spike in a long window: averaged into the line, the highest sample kept beside it', () => {
		// 30 s at 32% in a day at 10% (Irithyll, 2026-11-01): the 24h chart said its peak was 14%.
		const points = bucketSamples(day(10, (i) => (i >= 4000 && i < 4003 ? 32 : null)));
		expect(points.length).toBeLessThanOrEqual(240);
		expect(Math.max(...points.map((p) => p.cpuPercent))).toBeLessThan(15);
		expect(Math.max(...points.map((p) => p.cpuPeak))).toBe(32);
		expect(Math.max(...points.map((p) => p.memoryPeak))).toBe(1500);
		// Elsewhere the peak is the average: no band where nothing happened.
		expect(points.filter((p) => p.cpuPeak !== p.cpuPercent)).toHaveLength(1);
	});

	it('leave a short window as it is, each point its own peak', () => {
		const samples = day(10, () => null).slice(0, 100);
		expect(bucketSamples(samples)).toEqual(samples.map((s) => ({ ...s, cpuPeak: s.cpuPercent, memoryPeak: s.memoryBytes })));
	});
});
