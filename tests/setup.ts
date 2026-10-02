import os from 'node:os';
import path from 'node:path';

/**
 * Runs before every test file. Importing anything that touches the database
 * opens (and migrates) the SQLite file under MINESHELL_DATA. vite.config.ts
 * points that at a fresh temporary directory when Vitest runs; this aborts
 * the run outright if MineShell would resolve anything else, so a test can
 * never reach real data.
 */
const expected = process.env.MINESHELL_DATA;
const { DATA_DIR } = await import('$lib/server/config');
const resolved = path.resolve(DATA_DIR);
if (!expected || resolved !== path.resolve(expected) || !resolved.startsWith(os.tmpdir())) {
	throw new Error(
		`Refusing to run tests: MineShell resolved its data directory to ${DATA_DIR} (expected a temporary directory, got MINESHELL_DATA=${expected}).`
	);
}
