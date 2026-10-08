import { describe, expect, it } from 'vitest';
import { listRuns, readJournalEvents, readLastRun, readRun, runFinishedStarting, searchJournal } from './journal';
import { fakeProcesses, spawnCalls } from '../../../tests/helpers/process';

const INVOCATION = '05cab01dbf7f460a8c7facc67e5cd7d5';
const RUN = 'Started minecraft@pack.service - Minecraft server.\n[16:02:40] [Server thread/INFO]: Done (12.3s)!\n';

/** A journal whose newest entry is `cursor`, belonging to INVOCATION. */
function journal(cursor: string) {
	fakeProcesses((_cmd, args) => {
		if (args.includes('json')) {
			return { stdout: JSON.stringify({ __CURSOR: cursor, USER_INVOCATION_ID: INVOCATION, MESSAGE: 'Consumed 4min CPU time.' }) + '\n' };
		}
		if (args.includes(`_SYSTEMD_INVOCATION_ID=${INVOCATION}`)) return { stdout: RUN };
		return {};
	});
}

describe('readLastRun', () => {
	it('reads only the newest run, by its invocation id', async () => {
		journal('s=1');
		expect(await readLastRun('pack-a')).toBe(RUN);
		const read = spawnCalls.find((c) => c.args.includes('cat'))!;
		expect(read.args).toEqual(expect.arrayContaining([`USER_INVOCATION_ID=${INVOCATION}`, `INVOCATION_ID=${INVOCATION}`]));
		// Line-count reads of the whole unit took seconds on a big pack.
		expect(read.args.some((a) => a.startsWith('--user-unit') || a === '-u')).toBe(false);
	});

	it('reuses the run read before while the journal has nothing newer', async () => {
		journal('s=1');
		await readLastRun('pack-b');
		journal('s=1');
		expect(await readLastRun('pack-b')).toBe(RUN);
		expect(spawnCalls).toHaveLength(1);

		journal('s=2');
		await readLastRun('pack-b');
		expect(spawnCalls).toHaveLength(2);
	});

	it('ignores runs from before the instance existed', async () => {
		// A server deleted and recreated under the same name shares the unit's journal.
		fakeProcesses(() => ({ stdout: '' }));
		const createdAt = Date.UTC(2026, 9, 3, 12);
		expect(await readLastRun('pack-c', createdAt)).toBe('');
		expect(spawnCalls[0].args).toContain(`--since=@${createdAt / 1000}`);
	});
});

describe('runFinishedStarting', () => {
	it('searches the whole run for Done, not just its last lines', async () => {
		fakeProcesses((_cmd, args) => {
			if (args.includes('json')) return { stdout: JSON.stringify({ __CURSOR: 's=9', _SYSTEMD_INVOCATION_ID: INVOCATION }) + '\n' };
			if (args.includes('-g')) return { stdout: '[10:00:00] [Server thread/INFO]: Done (95.0s)!\n' };
			return {};
		});
		expect(await runFinishedStarting('pack-d')).toBe(true);
		const search = spawnCalls.find((c) => c.args.includes('-g'))!;
		expect(search.args).toContain(`_SYSTEMD_INVOCATION_ID=${INVOCATION}`);
		expect(search.args).not.toContain(String(20000));
	});

	it('is false while the run has not logged it', async () => {
		fakeProcesses((_cmd, args) =>
			args.includes('json') ? { stdout: JSON.stringify({ __CURSOR: 's=9', _SYSTEMD_INVOCATION_ID: INVOCATION }) + '\n' } : {}
		);
		expect(await runFinishedStarting('pack-e')).toBe(false);
	});
});

describe('listRuns', () => {
	it('groups the service manager lines into runs, newest first', async () => {
		// The journal's timestamps are microseconds; `at` is milliseconds.
		const line = (inv: string, at: number, message: string) => JSON.stringify({ USER_INVOCATION_ID: inv, __REALTIME_TIMESTAMP: String(at * 1000), MESSAGE: message });
		const a = 'a'.repeat(32);
		const b = 'b'.repeat(32);
		fakeProcesses((_cmd, args) => {
			if (args.includes('-g'))
				return {
					stdout: [
						line(a, 1000, 'Started minecraft@x.service - Minecraft server.'),
						line(a, 1006, 'minecraft@x.service: Main process exited, code=exited, status=1/FAILURE'),
						line(a, 1006, "minecraft@x.service: Failed with result 'exit-code'."),
						line(b, 2000, 'Started minecraft@x.service - Minecraft server.'),
						line(b, 2300, 'minecraft@x.service: Consumed 4min CPU time.')
					].join('\n')
				};
			if (args.includes('json')) return { stdout: JSON.stringify({ __CURSOR: 's=1', USER_INVOCATION_ID: b }) + '\n' };
			return {};
		});
		expect(await listRuns('runs-a')).toEqual([
			{ invocation: b, startedAt: 2000, endedAt: 2300, exit: null, failure: null },
			{ invocation: a, startedAt: 1000, endedAt: 1006, exit: 'code=exited, status=1/FAILURE', failure: 'exit-code' }
		]);
	});
});

describe('listRuns', () => {
	it('searches only what was logged since the last call', async () => {
		// The whole unit's search took 1-3 s on a big pack, redone on every Logs visit while it ran.
		const line = (at: number, message: string) => JSON.stringify({ USER_INVOCATION_ID: 'c'.repeat(32), __REALTIME_TIMESTAMP: String(at * 1000), MESSAGE: message });
		const newest = (cursor: string) => ({ stdout: JSON.stringify({ __CURSOR: cursor }) + '\n' });
		fakeProcesses((_cmd, args) => (args.includes('-g') ? { stdout: line(1000, 'Started minecraft@x.service - Minecraft server.') } : newest('s=1')));
		const first = await listRuns('runs-b');
		expect(first).toEqual([{ invocation: 'c'.repeat(32), startedAt: 1000, endedAt: null, exit: null, failure: null }]);

		fakeProcesses((_cmd, args) => (args.includes('-g') ? { stdout: line(1500, 'minecraft@x.service: Consumed 4min CPU time.') } : newest('s=2')));
		expect(await listRuns('runs-b')).toEqual([{ invocation: 'c'.repeat(32), startedAt: 1000, endedAt: 1500, exit: null, failure: null }]);
		const search = spawnCalls.find((c) => c.args.includes('-g'))!;
		expect(search.args).toContain('--after-cursor=s=1');
		expect(search.args.some((a) => a.startsWith('--since'))).toBe(false);
		// The list handed out before is not changed under its holder.
		expect(first[0].endedAt).toBeNull();
	});
});

describe('readRun', () => {
	const RUN_ID = 'd'.repeat(32);

	it('reads only the lines logged since the last call', async () => {
		// 20000 lines take journalctl 1-2 s; the Logs page read them on every visit.
		fakeProcesses(() => ({ stdout: 'one\ntwo\n-- cursor: s=2\n' }));
		expect(await readRun(RUN_ID)).toBe('one\ntwo\n');
		expect(spawnCalls[0].args).toEqual(expect.arrayContaining(['-n', '20000', '--show-cursor']));

		fakeProcesses(() => ({ stdout: 'three\n-- cursor: s=3\n' }));
		expect(await readRun(RUN_ID)).toBe('one\ntwo\nthree\n');
		expect(spawnCalls[0].args).toContain('--after-cursor=s=2');
		expect(spawnCalls[0].args).not.toContain('-n');

		// Nothing new (an ended run): journalctl prints only the cursor.
		fakeProcesses(() => ({ stdout: '-- cursor: s=3\n' }));
		expect(await readRun(RUN_ID)).toBe('one\ntwo\nthree\n');
		expect(spawnCalls[0].args).toContain('--after-cursor=s=3');
	});

	it('keeps only the newest 20000 lines of a run that keeps logging', async () => {
		const many = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join('\n') + '\n';
		fakeProcesses(() => ({ stdout: many + '-- cursor: s=1\n' }));
		await readRun('e'.repeat(32));
		fakeProcesses(() => ({ stdout: 'line 20000\nline 20001\n-- cursor: s=2\n' }));
		const lines = (await readRun('e'.repeat(32))).split('\n');
		expect(lines).toHaveLength(20001);
		expect(lines[0]).toBe('line 2');
		expect(lines.at(-2)).toBe('line 20001');
	});
});

describe('journal lines with colour codes', () => {
	it('reads a message journalctl hands out as bytes', async () => {
		const coloured = '\x1b[32m[20:01:20] [Server thread/INFO] [minecraft/MinecraftServer]: Steve joined the game\x1b[0m';
		const entry = { __CURSOR: 'c', __REALTIME_TIMESTAMP: '5000000', _SYSTEMD_INVOCATION_ID: INVOCATION, MESSAGE: [...Buffer.from(coloured)] };
		fakeProcesses(() => ({ stdout: JSON.stringify(entry) + '\n' }));
		const { events } = await readJournalEvents('colour-a', 'joined', { afterCursor: null, since: 0 });
		expect(events.map((e) => e.message)).toEqual([coloured]);
	});
});

describe('searchJournal', () => {
	it('looks for the text as typed, in any case', async () => {
		fakeProcesses(() => ({ stdout: JSON.stringify({ __REALTIME_TIMESTAMP: '2000', MESSAGE: 'x', _SYSTEMD_INVOCATION_ID: INVOCATION }) + '\n' }));
		const found = await searchJournal('search-a', 'Done (12.3s) [x]|y', 0, 50);
		expect(found).toEqual([{ at: 2, message: 'x', invocation: INVOCATION }]);
		const args = spawnCalls.at(-1)!.args;
		expect(args[args.indexOf('-g') + 1]).toBe('Done \\(12\\.3s\\) \\[x\\]\\|y');
		expect(args).toEqual(expect.arrayContaining(['--case-sensitive=false', '-n', '50']));
	});
});
