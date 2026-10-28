import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepRunningOnRejections, logUnhandledRejection } from './crashguard';

afterEach(() => {
	vi.restoreAllMocks();
	process.off('unhandledRejection', logUnhandledRejection);
	delete (globalThis as { __mineshellRejectionGuard?: boolean }).__mineshellRejectionGuard;
});

describe('rejections nothing caught', () => {
	it('are logged with their stack instead of ending MineShell', () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		logUnhandledRejection(new Error('database or disk is full'));
		expect(logged).toHaveBeenCalledWith(expect.stringContaining('keeps running'), expect.stringContaining('database or disk is full\n    at '));
	});

	it('are handled once per process, however often boot code runs', () => {
		const before = process.listenerCount('unhandledRejection');
		keepRunningOnRejections();
		keepRunningOnRejections();
		expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
		expect(process.listeners('unhandledRejection')).toContain(logUnhandledRejection);
	});
});
