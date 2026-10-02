import os from 'node:os';
import path from 'node:path';
import { afterEach, vi } from 'vitest';
import { fakeSpawn, forbidden, resetProcesses } from './helpers/process';

/**
 * Runs before every test file.
 *
 * Real data: importing anything that touches the database opens (and
 * migrates) the SQLite file under MINESHELL_DATA, and systemd unit files live
 * under XDG_CONFIG_HOME. vite.config.ts points both at a fresh temporary
 * directory when Vitest runs; this aborts the run outright if MineShell would
 * resolve anything else.
 *
 * Real processes: node:child_process is replaced so nothing can run
 * systemctl, journalctl or java; tests describe process output with
 * fakeProcesses() (tests/helpers/process.ts).
 */
vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>();
	const replaced = {
		spawn: fakeSpawn,
		spawnSync: forbidden('spawnSync'),
		exec: forbidden('exec'),
		execSync: forbidden('execSync'),
		execFile: forbidden('execFile'),
		execFileSync: forbidden('execFileSync'),
		fork: forbidden('fork')
	};
	return { ...actual, ...replaced, default: { ...actual, ...replaced } };
});

afterEach(() => resetProcesses());

const expected = process.env.MINESHELL_DATA;
const { DATA_DIR, systemdUnitDir } = await import('$lib/server/config');
const tmp = path.resolve(os.tmpdir());
const resolved = path.resolve(DATA_DIR);
if (!expected || resolved !== path.resolve(expected) || !resolved.startsWith(tmp)) {
	throw new Error(
		`Refusing to run tests: MineShell resolved its data directory to ${DATA_DIR} (expected a temporary directory, got MINESHELL_DATA=${expected}).`
	);
}
if (!path.resolve(systemdUnitDir()).startsWith(resolved)) {
	throw new Error(`Refusing to run tests: systemd unit files would be written to ${systemdUnitDir()}.`);
}
