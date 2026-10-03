import { describe, expect, it } from 'vitest';
import { readLastRun } from './journal';
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
