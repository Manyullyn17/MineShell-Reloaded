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
			{ time: 3000, type: 'Health report', user: 'Alex', url: 'https://spark.lucko.me/def456', file: null },
			{ time: 2000, type: 'Profiler', user: 'Rcon', url: null, file: '/srv/mc/config/spark/profile-2026-10-04.sparkprofile' },
			{ time: 1000, type: 'Profiler', user: 'Rcon', url: 'https://spark.lucko.me/abc123', file: null }
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
