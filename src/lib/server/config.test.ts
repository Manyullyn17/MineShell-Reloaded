import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_DIR, INSTANCES_DIR, UNIT_PREFIX } from './config';

// The guard in tests/setup.ts is what keeps tests off real data; this makes
// sure it actually took effect.
describe('test isolation', () => {
	it('uses a temporary data directory', () => {
		expect(path.resolve(DATA_DIR).startsWith(os.tmpdir())).toBe(true);
		expect(INSTANCES_DIR.startsWith(DATA_DIR)).toBe(true);
	});

	it('uses a test unit prefix, never minecraft@', () => {
		expect(UNIT_PREFIX).toBe('mineshell-test');
	});
});
