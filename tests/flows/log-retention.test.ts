import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expireOldLogs, logKeepDays, resetLogChecks, setLogKeepDays } from '#lib/server/logretention.js';
import { createInstance } from '../helpers/instances';
import { ls } from '../helpers/fs';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 28, 12);

/** A server with logs and crash reports of these ages in days. */
async function server() {
	const instance = await createInstance(
		{ modloader: 'fabric', minecraftVersion: '1.21.1' },
		{
			'logs/latest.log': 'now',
			'logs/debug.log': 'now',
			'logs/2026-10-27-1.log.gz': 'yesterday',
			'logs/2026-08-01-1.log.gz': 'old',
			'logs/notes.txt': 'not a log',
			'crash-reports/crash-2026-10-20_10.00.00-server.txt': 'recent crash',
			'crash-reports/crash-2026-07-01_10.00.00-server.txt': 'old crash'
		}
	);
	const age = async (rel: string, days: number) => {
		const when = new Date(NOW - days * DAY);
		await fs.utimes(path.join(instance.path, rel), when, when);
	};
	await age('logs/latest.log', 400);
	await age('logs/debug.log', 400);
	await age('logs/2026-10-27-1.log.gz', 1);
	await age('logs/2026-08-01-1.log.gz', 88);
	await age('logs/notes.txt', 400);
	await age('crash-reports/crash-2026-10-20_10.00.00-server.txt', 8);
	await age('crash-reports/crash-2026-07-01_10.00.00-server.txt', 119);
	return instance;
}

afterEach(() => {
	setLogKeepDays(0);
	resetLogChecks();
});

describe('log retention', () => {
	it('keeps everything until a number of days is set', async () => {
		const instance = await server();
		expect(logKeepDays()).toBe(0);
		expect(await expireOldLogs(instance.id, instance.path, NOW)).toBe(0);
		expect(await ls(path.join(instance.path, 'logs'))).toHaveLength(5);
	});

	it('deletes archived logs and crash reports past the kept days, never the current logs or other files', async () => {
		const instance = await server();
		setLogKeepDays(30);
		expect(await expireOldLogs(instance.id, instance.path, NOW)).toBe(2);
		expect((await ls(path.join(instance.path, 'logs'))).sort()).toEqual(['2026-10-27-1.log.gz', 'debug.log', 'latest.log', 'notes.txt']);
		expect(await ls(path.join(instance.path, 'crash-reports'))).toEqual(['crash-2026-10-20_10.00.00-server.txt']);
	});

	it('looks at a server at most once an hour, since the scheduler checks every 30 seconds', async () => {
		const instance = await server();
		setLogKeepDays(100);
		expect(await expireOldLogs(instance.id, instance.path, NOW)).toBe(1);
		setLogKeepDays(30);
		expect(await expireOldLogs(instance.id, instance.path, NOW + 30 * 60_000)).toBe(0);
		expect(await expireOldLogs(instance.id, instance.path, NOW + 61 * 60_000)).toBe(1);
	});

	it('refuses days outside 0 to 3650', () => {
		for (const bad of [-1, 1.5, 3651, NaN]) expect(() => setLogKeepDays(bad)).toThrow(/0 to 3650/);
		expect(logKeepDays()).toBe(0);
	});
});
