import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { DATA_DIR, INSTANCES_DIR, UNIT_PREFIX, systemdUnitDir } from './config';

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

	it('writes systemd unit files inside the temporary directory', () => {
		expect(path.resolve(systemdUnitDir()).startsWith(path.resolve(DATA_DIR))).toBe(true);
	});

	// SvelteKit writes the env it was started with into its output folder, and
	// every dev server watching that folder reloads with it. Sharing the folder
	// switched a running `npm run dev` onto this run's temporary data.
	it('keeps its generated env out of the dev server folder', () => {
		const devEnv = path.resolve('.svelte-kit/generated/dev/env/config.js');
		const written = fs.existsSync(devEnv) ? fs.readFileSync(devEnv, 'utf8') : '';
		expect(written).not.toContain(DATA_DIR);
	});

	it('cannot use the network', async () => {
		await expect(fetch('https://api.modrinth.com/v2/tag/loader')).rejects.toThrow(/must not use the network/);
	});

	it('cannot start real processes', () => {
		expect(() => spawn('systemctl', ['--user', 'daemon-reload'])).toThrow(/must not start real processes/);
	});
});
