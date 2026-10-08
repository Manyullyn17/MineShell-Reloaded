import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const { matchesIn, searchLogs } = await import('#lib/server/logsearch.js');
const { createInstance } = await import('../helpers/instances');
const { fakeProcesses, spawnCalls } = await import('../helpers/process');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const entry = (inv: string, at: number, message: string) =>
	JSON.stringify({ __REALTIME_TIMESTAMP: String(at * 1000), _SYSTEMD_INVOCATION_ID: inv, MESSAGE: message });

describe('searching all logs', () => {
	it('finds the runs and files that mention it, any case, archives included', async () => {
		const s = await createInstance({ modloader: 'fabric', minecraftVersion: '1.20.1' }, {
			'logs/latest.log': '[10:00:00] [Server thread/INFO]: Steve joined the game\n[10:00:05] [Server thread/WARN]: Can\'t keep up!\n',
			'logs/2026-10-01-1.log.gz': gzipSync('[09:00:00] [Server thread/WARN]: can\'t keep up! Running 2000ms behind\n'.repeat(7)),
			'crash-reports/crash-2026-10-02.txt': 'java.lang.NullPointerException\n'
		});
		fakeProcesses((cmd, args) => {
			if (cmd !== 'journalctl') return {};
			if (args.includes('--case-sensitive=false')) {
				return { stdout: [entry(A, 1000, '\x1b[33m[x] [Server thread/WARN]: Can\'t keep up!\x1b[0m'), entry(B, 5000, "[y] [Server thread/WARN]: Can't keep up!"), entry(B, 5001, "[y] [Server thread/WARN]: Can't keep up!")].join('\n') };
			}
			// listRuns: when each run started.
			if (args.includes('-g')) return { stdout: [entry(A, 900, 'Started x.service'), entry(B, 4900, 'Started x.service')].join('\n') };
			return { stdout: JSON.stringify({ __CURSOR: 'c', __REALTIME_TIMESTAMP: '5001000' }) + '\n' };
		});
		const found = await searchLogs(s, "CAN'T KEEP UP");
		expect(found.runs.map((h) => [h.key, h.at, h.count])).toEqual([[B, 4900, 2], [A, 900, 1]]);
		expect(found.runs[1].lines).toEqual(["[x] [Server thread/WARN]: Can't keep up!"]);
		expect(found.files.map((h) => [h.key, h.count, h.lines.length]).sort()).toEqual([
			['logs/2026-10-01-1.log.gz', 7, 4],
			['logs/latest.log', 1, 1]
		]);
		// The text is looked for as typed, not as a regular expression.
		const grep = spawnCalls.find((c) => c.args.includes('--case-sensitive=false'))!.args;
		expect(grep[grep.indexOf('-g') + 1]).toBe("CAN'T KEEP UP");
	});

	it('lists the open log\'s matching lines from all of it, with line numbers for files', async () => {
		const lines = Array.from({ length: 300_000 }, (_, i) => (i % 100_000 === 7 ? `line ${i} OutOfMemoryError` : `line ${i} fine`));
		const s = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' }, { 'logs/debug.log': lines.join('\n') });
		expect(await matchesIn(s, 'file', 'logs/debug.log', 'outofmemory')).toEqual([
			{ line: 8, text: 'line 7 OutOfMemoryError' },
			{ line: 100_008, text: 'line 100007 OutOfMemoryError' },
			{ line: 200_008, text: 'line 200007 OutOfMemoryError' }
		]);
		expect(await matchesIn(s, 'file', '../server.properties', 'outofmemory')).toEqual([]);
	});

	it('does not search for less than two characters', async () => {
		const s = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		spawnCalls.length = 0;
		expect(await searchLogs(s, ' a ')).toEqual({ query: 'a', runs: [], files: [], partial: false });
		expect(spawnCalls).toEqual([]);
	});
});
