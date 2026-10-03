import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitStop, GRACEFUL_STOP_MS, start } from './instances';
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
	beforeEach(() => vi.useFakeTimers());
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
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' }, { 'eula.txt': 'eula=true' });
		unit();
		awaitStop(instance.id, Date.now() + 1000);
		await start(instance).catch(() => undefined);
		spawnCalls.length = 0;
		await vi.advanceTimersByTimeAsync(GRACEFUL_STOP_MS);
		expect(systemctlStops()).toEqual([]);
	});
});
