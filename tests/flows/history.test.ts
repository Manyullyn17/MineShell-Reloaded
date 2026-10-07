import { beforeEach, describe, expect, it } from 'vitest';

const { applyEvents, crashCausesByRun, onlineSince, peakPlayers, playtimes, recentCrashes, recordHistory, startTimes, startTimesByRun } = await import('#lib/server/history.js');
const { createInstance, reload } = await import('../helpers/instances');
const { fakeProcesses, spawnCalls } = await import('../helpers/process');

const MIN = 60_000;
const T0 = new Date('2026-10-07T10:00:00').getTime();
const inv = (n: number) => String(n).padStart(32, 'a');
const line = (text: string) => `[10:00:00] [Server thread/INFO]: ${text}`;
const ev = (at: number, message: string, run: number | null = 1) => ({ at, message, invocation: run === null ? null : inv(run) });

async function server() {
	return createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', createdAt: T0 - 60 * MIN });
}

describe('server history from journal events', () => {
	it('records runs with their start time, and sessions from joins and leaves', async () => {
		const s = await server();
		applyEvents(s.id, [
			ev(T0, 'Started mstest@x.service - Minecraft server'),
			ev(T0 + 2 * MIN + 31_000, line('Done (12.3s)! For help, type "help"')),
			ev(T0 + 5 * MIN, line('Alex joined the game')),
			ev(T0 + 6 * MIN, line('Steve joined the game')),
			// A second join line while already on (a relog race) opens nothing new.
			ev(T0 + 6 * MIN, line('Steve joined the game')),
			ev(T0 + 20 * MIN, line('Alex lost connection: Disconnected')),
			ev(T0 + 20 * MIN, line('Alex left the game')),
			// Chat cannot fake a join.
			ev(T0 + 21 * MIN, line('<Steve> Herobrine joined the game'))
		]);
		expect(startTimes(s.id)).toMatchObject({ lastMs: 2 * MIN + 31_000, usualMs: null });
		expect(startTimesByRun(s.id)).toEqual({ [inv(1)]: 2 * MIN + 31_000 });
		expect(Object.keys(onlineSince(s.id))).toEqual(['Steve']);
		expect(peakPlayers(s.id, T0, T0 + 30 * MIN)).toBe(2);
		expect(playtimes(s.id, T0 + 30 * MIN)).toEqual({
			Alex: { totalMs: 15 * MIN, lastSeen: T0 + 20 * MIN, online: false },
			Steve: { totalMs: 24 * MIN, lastSeen: T0 + 30 * MIN, online: true }
		});
	});

	it('closes every open session when the run ends, logged or not', async () => {
		const s = await server();
		applyEvents(s.id, [
			ev(T0, 'Started x.service'),
			ev(T0 + MIN, line('Alex joined the game')),
			ev(T0 + 10 * MIN, 'x.service: Main process exited, code=exited, status=1/FAILURE'),
			ev(T0 + 11 * MIN, 'Started x.service', 2),
			ev(T0 + 12 * MIN, line('Steve joined the game'), 2),
			// Killed with no stop line: the next start closes Steve's session.
			ev(T0 + 40 * MIN, 'Started x.service', 3)
		]);
		expect(onlineSince(s.id)).toEqual({});
		expect(playtimes(s.id, T0 + 60 * MIN)).toEqual({
			Alex: { totalMs: 9 * MIN, lastSeen: T0 + 10 * MIN, online: false },
			Steve: { totalMs: 28 * MIN, lastSeen: T0 + 40 * MIN, online: false }
		});
	});

	it('compares the newest start with the usual (median of the ones before)', async () => {
		const s = await server();
		const events: ReturnType<typeof ev>[] = [];
		const took = [120, 130, 125, 140, 300]; // seconds; the last start is slow
		took.forEach((sec, i) => {
			const at = T0 + i * 60 * MIN;
			events.push(ev(at, 'Started x.service', i + 1), ev(at + sec * 1000, line('Done (9.1s)!'), i + 1));
		});
		applyEvents(s.id, events);
		expect(startTimes(s.id)).toMatchObject({ lastMs: 300_000, usualMs: 130_000, runs: 5 });
	});

	it('counts a relog at the same moment as one person for the peak', async () => {
		const s = await server();
		applyEvents(s.id, [
			ev(T0, 'Started x.service'),
			ev(T0 + MIN, line('Alex joined the game')),
			ev(T0 + 2 * MIN, line('Alex left the game')),
			ev(T0 + 2 * MIN, line('Alex joined the game'))
		]);
		expect(peakPlayers(s.id, T0, T0 + 5 * MIN)).toBe(1);
	});
});

describe('crash history', () => {
	it('marks crashed runs: failures and stops before Done, not asked-for stops', async () => {
		const s = await server();
		const at = (h: number) => T0 + h * 60 * MIN;
		applyEvents(s.id, [
			// 1: ran, then stopped over RCON: exit 0, nothing logged about the exit.
			ev(at(0), 'Started x.service', 1),
			ev(at(0) + MIN, line('Done (5.0s)!'), 1),
			ev(at(1), 'x.service: Deactivated successfully.', 1),
			// 2: crashed while running.
			ev(at(2), 'Started x.service', 2),
			ev(at(2) + MIN, line('Done (5.0s)!'), 2),
			ev(at(3), 'x.service: Main process exited, code=exited, status=1/FAILURE', 2),
			ev(at(3), "x.service: Failed with result 'exit-code'.", 2),
			// 3: stopped through systemd (SIGTERM) while still starting: asked for.
			ev(at(4), 'Started x.service', 3),
			ev(at(4) + MIN, 'x.service: Main process exited, code=exited, status=143/n/a', 3),
			ev(at(4) + MIN, 'Stopped x.service.', 3),
			// 4: a startup crash the loader caught: exit 0, never Done.
			ev(at(5), 'Started x.service', 4),
			ev(at(5) + MIN, 'x.service: Deactivated successfully.', 4)
		]);
		expect(recentCrashes(s.id, 0).map((c) => c.invocation)).toEqual([inv(4), inv(2)]);
	});

	it('puts each crash through the crash analyzer once', async () => {
		const s = await server();
		const crashLog = [
			'Started x.service',
			'[10:00:01] [main/ERROR] [FML]: Missing or unsupported mandatory dependencies:',
			'[10:00:01] [main/INFO] [Server thread/INFO]: whatever'
		].join('\n');
		let runReads = 0;
		fakeProcesses((cmd, args) => {
			if (cmd !== 'journalctl') return {};
			if (args.some((a) => a.startsWith('_SYSTEMD_INVOCATION_ID='))) {
				runReads++;
				return { stdout: crashLog + '\n' };
			}
			if (args.includes('-n')) return { stdout: JSON.stringify({ __CURSOR: 'k', __REALTIME_TIMESTAMP: String((T0 + 5 * MIN) * 1000) }) + '\n' };
			const e = (at: number, message: string) => JSON.stringify({ MESSAGE: message, __REALTIME_TIMESTAMP: String(at * 1000), _SYSTEMD_INVOCATION_ID: inv(9) });
			return { stdout: [e(T0, 'Started x.service'), e(T0 + MIN, "x.service: Failed with result 'exit-code'.")].join('\n') + '\n' };
		});
		await recordHistory(reload(s.id));
		const [crash] = recentCrashes(s.id, 0);
		expect(crash).toMatchObject({ invocation: inv(9), diagnosed: true });
		expect(runReads).toBe(1);
		await recordHistory(reload(s.id));
		expect(runReads).toBe(1);
		expect(Object.keys(crashCausesByRun(s.id))).toEqual(crash.cause ? [inv(9)] : []);
	});
});

describe('reading the journal', () => {
	let newest: { cursor: string; at: number };
	let matches: Record<string, unknown>[];
	beforeEach(() => {
		fakeProcesses((cmd, args) => {
			if (cmd !== 'journalctl') return {};
			if (args.includes('-n')) return { stdout: JSON.stringify({ __CURSOR: newest.cursor, __REALTIME_TIMESTAMP: String(newest.at * 1000) }) + '\n' };
			return { stdout: matches.map((m) => JSON.stringify(m)).join('\n') + '\n' };
		});
	});
	const entry = (at: number, message: string) => ({ MESSAGE: message, __REALTIME_TIMESTAMP: String(at * 1000), _SYSTEMD_INVOCATION_ID: inv(1) });

	it('starts from the creation on the first read, then continues after the stored position', async () => {
		const s = await server();
		newest = { cursor: 'c1', at: T0 + 5 * MIN };
		matches = [entry(T0, 'Started x.service'), entry(T0 + MIN, line('Alex joined the game'))];
		await recordHistory(reload(s.id));
		const firstRead = spawnCalls.filter((c) => c.cmd === 'journalctl' && c.args.includes('-g'))[0].args;
		expect(firstRead).toContain(`--since=@${Math.floor((T0 - 60 * MIN) / 1000)}`);
		expect(reload(s.id).historyCursor).toBe('c1');
		expect(Object.keys(onlineSince(s.id))).toEqual(['Alex']);

		// A match newer than the newest entry read first waits for the next read.
		newest = { cursor: 'c2', at: T0 + 10 * MIN };
		matches = [entry(T0 + 8 * MIN, line('Alex left the game')), entry(T0 + 11 * MIN, line('Steve joined the game'))];
		spawnCalls.length = 0;
		await recordHistory(reload(s.id));
		expect(spawnCalls.find((c) => c.args.includes('-g'))!.args).toContain('--after-cursor=c1');
		expect(onlineSince(s.id)).toEqual({});
		expect(reload(s.id).historyCursor).toBe('c2');
	});

	it('does not read again when nothing new was logged', async () => {
		const s = await server();
		newest = { cursor: 'same', at: T0 };
		matches = [];
		await recordHistory(reload(s.id));
		spawnCalls.length = 0;
		await recordHistory(reload(s.id));
		expect(spawnCalls.filter((c) => c.args.includes('-g'))).toEqual([]);
	});
});
