import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { isLogPath, listLogFiles, readLogFile, SHOWN_BYTES } from './logfiles';
import { tempDir } from '../../../tests/helpers/fs';

describe('server log files', () => {
	it('lists crash reports and logs, not other folders or files', async () => {
		const root = await tempDir('logs-');
		await fs.mkdir(path.join(root, 'logs', 'buildcraft'), { recursive: true });
		await fs.mkdir(path.join(root, 'crash-reports'), { recursive: true });
		await fs.writeFile(path.join(root, 'logs', 'latest.log'), 'now');
		await fs.writeFile(path.join(root, 'logs', '2026-10-01-1.log.gz'), zlib.gzipSync('before'));
		await fs.writeFile(path.join(root, 'logs', 'chickens.gml'), 'not a log');
		await fs.writeFile(path.join(root, 'crash-reports', 'crash-1.txt'), 'crash');
		expect((await listLogFiles(root)).map((f) => f.path).sort()).toEqual([
			'crash-reports/crash-1.txt',
			'logs/2026-10-01-1.log.gz',
			'logs/latest.log'
		]);
		expect(await readLogFile(root, 'logs/2026-10-01-1.log.gz')).toEqual({ text: 'before', truncated: false });
	});

	it('shows only the end of a long file, from a whole line', async () => {
		const root = await tempDir('logs-');
		await fs.mkdir(path.join(root, 'logs'), { recursive: true });
		const lines = Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join('\n');
		await fs.writeFile(path.join(root, 'logs', 'debug.log'), lines);
		const read = (await readLogFile(root, 'logs/debug.log'))!;
		expect(read.truncated).toBe(true);
		expect(read.text.length).toBeLessThanOrEqual(SHOWN_BYTES);
		expect(read.text.split('\n')[0]).toMatch(/^line \d+$/);
		expect(read.text.endsWith('line 199999')).toBe(true);
	});

	it('reads nothing outside those two folders', async () => {
		expect(isLogPath('logs/latest.log')).toBe(true);
		expect(isLogPath('logs/../server.properties')).toBe(false);
		expect(isLogPath('logs/buildcraft/x.log')).toBe(false);
		expect(isLogPath('world/level.dat')).toBe(false);
		expect(await readLogFile('/tmp', '../etc/passwd')).toBeNull();
	});
});
