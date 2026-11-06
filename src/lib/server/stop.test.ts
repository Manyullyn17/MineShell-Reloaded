import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitStop, forceStop, GRACEFUL_STOP_MS, start, stuckStopping } from './instances';
import { invalidateUnitState } from './systemd';
import { fakeProcesses, spawnCalls } from '../../../tests/helpers/process';
import { createInstance } from '../../../tests/helpers/instances';

/** systemctl reports `active` until `stopped()` is called. */
function unit() {
	let active = 'active';
	invalidateUnitState();
	fakeProcesses((_cmd, args) => (args.includes('show') ? { stdout: `ActiveState=${active}\nSubState=x\n` } : {}));
	return { stopped: () => (active = 'inactive') };
}

const systemctlStops = () => spawnCalls.filter((c) => c.args[0] === '--user' && c.args[1] === 'stop');

describe('stopping over RCON', () => {
	// Only the clock the stop logic waits on: the fake processes answer through
	// setImmediate, so faking that too hung start() whenever it got as far as
	// systemd - on CI, where nothing else holds the port.
	beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
	afterEach(() => vi.useRealTimers());

	it('lets a slow save finish instead of stopping the unit after a fixed delay', async () => {
		const u = unit();
		awaitStop('slow-save', Date.now() + GRACEFUL_STOP_MS);
		// Still saving a minute and a half in: the old 20 s timer had sent SIGTERM by now.
		await vi.advanceTimersByTimeAsync(90_000);
		expect(systemctlStops()).toEqual([]);
		u.stopped();
		await vi.advanceTimersByTimeAsync(GRACEFUL_STOP_MS);
		expect(systemctlStops()).toEqual([]);
	});

	it('stops it through systemd once the grace period is over', async () => {
		unit();
		awaitStop('stuck-save', Date.now() + GRACEFUL_STOP_MS);
		await vi.advanceTimersByTimeAsync(GRACEFUL_STOP_MS + 10_000);
		expect(systemctlStops()).toHaveLength(1);
	});

	it('forgets the pending stop when the server is started again', async () => {
		// Port 0 is always free: start() goes all the way to systemd, as on a machine with no server running.
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', serverPort: 0, rconPort: 0 }, { 'eula.txt': 'eula=true' });
		unit();
		awaitStop(instance.id, Date.now() + 1000);
		await start(instance).catch(() => undefined);
		spawnCalls.length = 0;
		await vi.advanceTimersByTimeAsync(GRACEFUL_STOP_MS);
		expect(systemctlStops()).toEqual([]);
	});
});

describe('Force stop', () => {
	it('kills the process, after a stop job so that Restart=on-failure does not bring it back', async () => {
		unit().stopped();
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		spawnCalls.length = 0;
		expect(await forceStop(instance)).toMatchObject({ ok: true });
		const calls = spawnCalls.filter((c) => c.args[0] === '--user' && ['stop', 'kill', 'reset-failed'].includes(c.args[1])).map((c) => c.args.slice(1, 3));
		expect(calls).toEqual([
			['stop', '--no-block'],
			['kill', '--signal=SIGKILL'],
			['reset-failed', expect.any(String)]
		]);
	});
});

describe('Force stop just as a server ended by itself', () => {
	it('says so instead of systemd\'s error', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		invalidateUnitState();
		fakeProcesses((_cmd, args) =>
			args.includes('show') ? { stdout: 'ActiveState=inactive\nSubState=dead\n' } : args.includes('kill') ? { code: 1, stderr: 'Failed to kill unit: no process' } : {}
		);
		expect(await forceStop(instance)).toEqual({ ok: true, message: 'It had already stopped.' });
	});
});

describe('a server stuck on its way down', () => {
	const journal = (text: string) => fakeProcesses((cmd) => (cmd === 'journalctl' ? { stdout: text } : {}));

	it('is told from the lines Minecraft logs, with whether its save got through', async () => {
		journal('ThreadedAnvilChunkStorage: All dimensions are saved\nWaited 5 seconds attempting force stop!\n');
		expect(await stuckStopping('stuck', 1)).toEqual({ saved: true });
		journal('Thread net.minecraft.class_3389@5e114f7 (WAITING) failed to exit after 2 seconds\n');
		expect(await stuckStopping('stuck', 1)).toEqual({ saved: false });
	});

	it('is not one that is only saving', async () => {
		journal('Saving worlds\nSaving chunks for level\n');
		expect(await stuckStopping('saving', 1)).toBeNull();
	});
});
