import fs from 'node:fs';
import path from 'node:path';

/**
 * The data directory of this test worker: its own folder inside the run's
 * throwaway one (vite.config.ts), so files running side by side in other
 * workers never share a database or server folders. Made once per worker
 * process (files sharing modules run setup.ts again; globalThis outlives them).
 */
export function workerDataDir(): string {
	const shared = globalThis as { __workerDataDir?: string };
	if (shared.__workerDataDir) return shared.__workerDataDir;
	const run = process.env.MINESHELL_RUN_DATA ?? process.env.MINESHELL_DATA;
	if (!run) throw new Error('No throwaway data directory for this test run (vite.config.ts sets MINESHELL_DATA).');
	process.env.MINESHELL_RUN_DATA = run;
	const dir = fs.mkdtempSync(path.join(run, 'worker-'));
	process.env.MINESHELL_DATA = dir;
	process.env.XDG_CONFIG_HOME = path.join(dir, 'xdg-config');
	return (shared.__workerDataDir = dir);
}

/**
 * `$app/env/private` with the worker's own directories in place of the run's.
 * SvelteKit fixes that module's values once per run, in the main process, so
 * tests/setup.ts mocks it with this; a test file mocking it itself spreads this
 * over the original too (a file's own vi.mock replaces setup.ts's).
 */
export function workerEnv<T extends Record<string, unknown>>(actual: T): T {
	const dir = workerDataDir();
	return { ...actual, MINESHELL_DATA: dir, XDG_CONFIG_HOME: path.join(dir, 'xdg-config') };
}
