import { afterEach, describe, expect, it, vi } from 'vitest';

const rcon = vi.hoisted(() => ({ commands: [] as string[] }));
vi.mock('#lib/server/rcon.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/rcon.js')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		rcon.commands.push(...commands);
		return commands.map(() => '');
	})
}));

const { applyEvents, startTimes } = await import('#lib/server/history.js');
const { doneStartingAt } = await import('#lib/server/startphase.js');
const { sendCommand, stop, summarise } = await import('#lib/server/instances.js');
const { encryptSecret } = await import('#lib/server/crypto.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { createInstance } = await import('../helpers/instances');
const { fakeProcesses, spawnCalls } = await import('../helpers/process');

const MIN = 60_000;
const T0 = new Date('2026-10-07T10:00:00').getTime();
const inv = (n: number) => String(n).padStart(32, 'b');
const ev = (at: number, message: string, run = 1) => ({ at, message, invocation: inv(run) });
const done = '[10:00:00] [Server thread/INFO]: Done (95.1s)! For help, type "help"';
const doneEntry = (at: number) => JSON.stringify({ __REALTIME_TIMESTAMP: String(at * 1000), _SYSTEMD_INVOCATION_ID: inv(1), MESSAGE: done }) + '\n';

async function server() {
	return createInstance({ modloader: 'cleanroom', minecraftVersion: '1.12.2', createdAt: T0 - 60 * MIN });
}

/** systemd: active since boot + `monotonicUs` (while `up()`); the journal's "Done (" search answers `journal`. */
function running(monotonicUs: number, journal: () => string, up = () => true) {
	invalidateUnitState();
	fakeProcesses((cmd, args) => {
		if (cmd === 'systemctl' && args.includes('show'))
			return {
				stdout: up()
					? `ActiveState=active\nSubState=running\nActiveEnterTimestampMonotonic=${monotonicUs}\nResult=success\n`
					: 'ActiveState=inactive\nSubState=dead\nResult=success\n'
			};
		if (cmd === 'journalctl' && args.includes('-g')) return { stdout: journal() };
		return {};
	});
}

describe('a running server that has not finished starting', () => {
	// The bug: systemd calls the unit active as soon as Java runs, so a big pack
	// showed "Running" and counted uptime for the minutes before "Done (".
	it('is starting, with no uptime, until it logs "Done (", and uptime counts from there', async () => {
		const s = await server();
		let journal = '';
		running(1_000_000, () => journal);
		const before = await summarise(s);
		expect(before).toMatchObject({ running: true, starting: true, doneAt: null, uptimeMs: 0 });

		const startedAt = before.state.activeEnterTimestamp;
		journal = doneEntry(startedAt + 95_000);
		// Still starting a moment ago is believed for a moment: pages poll every few seconds.
		expect(await doneStartingAt(s.id, s.createdAt, startedAt)).toBeNull();
		expect(await doneStartingAt(s.id, s.createdAt, startedAt, Date.now() + 5000)).toBe(startedAt + 95_000);
		const after = await summarise(s);
		expect(after).toMatchObject({ starting: false, doneAt: startedAt + 95_000 });
		expect(after.uptimeMs).toBeCloseTo(Date.now() - (startedAt + 95_000), -3);
	});

	it('takes the run history\'s "Done" without reading the journal, and remembers a finished start', async () => {
		const s = await server();
		running(1_000_000, () => '');
		const startedAt = (await summarise(s)).state.activeEnterTimestamp;
		applyEvents(s.id, [ev(startedAt + 400, 'Started mstest@x.service'), ev(startedAt + 95_000, done)]);
		spawnCalls.length = 0;
		expect(await doneStartingAt(s.id, s.createdAt, startedAt, Date.now() + 5000)).toBe(startedAt + 95_000);
		expect(spawnCalls.filter((c) => c.cmd === 'journalctl')).toEqual([]);
	});
});

describe('a server told to stop', () => {
	afterEach(() => vi.useRealTimers());

	// Like starting: the RCON stop leaves systemd calling the unit active while the
	// server saves, which can take minutes on a big pack, so it showed "Running".
	it.each([
		['the Stop button', (s: Awaited<ReturnType<typeof server>>) => stop(s)],
		['stop in the console', (s: Awaited<ReturnType<typeof server>>) => sendCommand(s, 'stop')]
	])('is stopping from %s until the process is gone', async (_how, stopIt) => {
		const s = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', rconPasswordEnc: encryptSecret('pw') });
		let up = true;
		running(1_000_000, () => doneEntry(Date.now() - 10 * MIN), () => up);
		expect((await summarise(s)).phase).toBe(null);

		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		await stopIt(s);
		expect(rcon.commands).toContain('stop');
		expect(await summarise(s)).toMatchObject({ running: true, stopping: true, phase: 'stopping' });

		up = false;
		invalidateUnitState();
		await vi.advanceTimersByTimeAsync(3500);
		expect(await summarise(s)).toMatchObject({ running: false, stopping: false, phase: null });
	});
});

describe('the overview\'s start time', () => {
	it('is the running server\'s own only once it finished starting, before the history has it too', async () => {
		const s = await server();
		applyEvents(s.id, [ev(T0, 'Started x.service'), ev(T0 + 120_000, done)]);
		const now = T0 + 60 * MIN;
		// Stopped, or starting again: the earlier run's start, not "started in".
		expect(startTimes(s.id)).toMatchObject({ lastMs: 120_000, current: false });
		expect(startTimes(s.id, { startedAt: now, doneAt: null })).toMatchObject({ lastMs: 120_000, current: false });
		// Done, but the history (read every 30 s) has not seen it yet.
		expect(startTimes(s.id, { startedAt: now, doneAt: now + 90_000 })).toMatchObject({ lastMs: 90_000, current: true, runs: 2 });
		// The history caught up: the same answer, the run counted once.
		applyEvents(s.id, [ev(now + 300, 'Started x.service', 2), ev(now + 90_000, done, 2)]);
		expect(startTimes(s.id, { startedAt: now, doneAt: now + 90_000 })).toMatchObject({ lastMs: 89_700, current: true, runs: 2 });
	});
});
