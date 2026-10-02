import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Removes the run's throwaway data directory (created in vite.config.ts, also
 * home to every tempDir() from tests/helpers) once all tests are done. Only a
 * directory inside the system temp folder named mineshell-test-* is ever
 * removed.
 */
export default function setup() {
	return () => {
		const dir = process.env.MINESHELL_DATA;
		if (!dir) return;
		const resolved = path.resolve(dir);
		if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('mineshell-test-')) {
			fs.rmSync(resolved, { recursive: true, force: true });
		}
	};
}
