import { describe, expect, it } from 'vitest';
import { parseActivity } from './spark';

/** Shaped like Spark's Activity.serialize(). */
const entry = (time: number, type: string, kind: string, value: string, name = 'Rcon') => ({
	user: { type: 'other', name },
	time,
	type,
	data: { type: kind, value }
});

describe('parseActivity', () => {
	it('reads uploads and saved files, newest first', () => {
		const raw = JSON.stringify([
			entry(1000, 'Profiler', 'url', 'https://spark.lucko.me/abc123'),
			entry(3000, 'Health report', 'url', 'https://spark.lucko.me/def456', 'Alex'),
			entry(2000, 'Profiler', 'file', '/srv/mc/config/spark/profile-2026-10-04.sparkprofile')
		]);
		expect(parseActivity(raw)).toEqual([
			{ time: 3000, type: 'Health report', user: 'Alex', url: 'https://spark.lucko.me/def456', file: null, path: null, retryable: false },
			// Absolute: sparkUploads, which knows the server's folder, decides whether it is inside it.
			{ time: 2000, type: 'Profiler', user: 'Rcon', url: null, file: '/srv/mc/config/spark/profile-2026-10-04.sparkprofile', path: null, retryable: false },
			{ time: 1000, type: 'Profiler', user: 'Rcon', url: 'https://spark.lucko.me/abc123', file: null, path: null, retryable: false }
		]);
	});

	it('knows a saved file by its path in the server folder, and only a profile can be uploaded again', () => {
		const raw = JSON.stringify([
			// As Spark 1.10.156 wrote it when its upload timed out (irithyll, October 2026).
			entry(3000, 'Profiler', 'file', './config/spark/profile-2026-10-11_01.33.31.sparkprofile'),
			entry(2000, 'Heap dump summary', 'file', './config/spark/heap-summary.sparkheap'),
			entry(1000, 'Profiler', 'file', '../../etc/passwd')
		]);
		expect(parseActivity(raw).map((u) => [u.path, u.retryable])).toEqual([
			['config/spark/profile-2026-10-11_01.33.31.sparkprofile', true],
			['config/spark/heap-summary.sparkheap', false],
			[null, false]
		]);
	});

	it('never passes on a link that is not http(s)', () => {
		const raw = JSON.stringify([entry(1000, 'Profiler', 'url', 'javascript:alert(1)')]);
		expect(parseActivity(raw)).toEqual([]);
	});

	it('skips malformed entries and survives a broken file', () => {
		const raw = JSON.stringify([null, { time: 'x' }, { time: 1, type: 'Profiler' }, entry(5, 'Profiler', 'url', 'https://a.b/c')]);
		expect(parseActivity(raw).map((u) => u.time)).toEqual([5]);
		expect(parseActivity('{"half')).toEqual([]);
		expect(parseActivity('{}')).toEqual([]);
	});
});
