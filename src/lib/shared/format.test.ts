import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeState, formatBytes, formatDuration, formatRelative, gaveUpAfter } from './format';

describe('formatBytes', () => {
	it.each([
		[0, '0 B'],
		[-5, '0 B'],
		[512, '512 B'],
		[1024, '1.0 KB'],
		[1536, '1.5 KB'],
		[2 * 1024 ** 3, '2.0 GB']
	])('%i -> %s', (bytes, text) => {
		expect(formatBytes(bytes)).toBe(text);
	});
});

describe('formatDuration', () => {
	it.each([
		[0, '0m'],
		[59_000, '0m'],
		[61 * 60_000, '1h 1m'],
		[26 * 3_600_000, '1d 2h']
	])('%i ms -> %s', (ms, text) => {
		expect(formatDuration(ms)).toBe(text);
	});
});

describe('formatRelative', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
	});
	afterEach(() => vi.useRealTimers());

	it('reads naturally in both directions', () => {
		const now = Date.now();
		expect(formatRelative(null)).toBe('never');
		expect(formatRelative(now - 10_000)).toBe('just now');
		expect(formatRelative(now + 10_000)).toBe('in under a minute');
		expect(formatRelative(now - 5 * 60_000)).toBe('5m ago');
		expect(formatRelative(now + 3 * 3_600_000)).toBe('in 3h');
		expect(formatRelative(now - 3 * 86_400_000)).toBe('3d ago');
	});
});

describe('gaveUpAfter', () => {
	it('names the limit when systemd stopped restarting a crashed server', () => {
		expect(gaveUpAfter('failed', 'start-limit-hit', 3)).toBe(3);
	});

	it('says nothing for a plain crash or a server that is not failed', () => {
		expect(gaveUpAfter('failed', 'exit-code', 3)).toBeNull();
		expect(gaveUpAfter('inactive', 'start-limit-hit', 3)).toBeNull();
	});
});

describe('describeState', () => {
	it.each([
		['active', 'running', 'Running', 'running'],
		['activating', 'start', 'Starting', 'busy'],
		['deactivating', 'stop', 'Stopping', 'busy'],
		['activating', 'auto-restart', 'Starting', 'busy'],
		['inactive', 'auto-restart', 'Restarting after a crash', 'busy'],
		['failed', 'failed', 'Crashed', 'failed'],
		['inactive', 'dead', 'Stopped', 'stopped']
	])('%s/%s -> %s', (active, sub, label, tone) => {
		expect(describeState(active, sub)).toEqual({ label, tone });
	});
});
