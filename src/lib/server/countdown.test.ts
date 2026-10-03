import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelCountdown, getCountdown, startCountdown } from './countdown';
import { invalidateUnitState } from './systemd';
import { fakeProcesses, spawnCalls } from '../../../tests/helpers/process';
import { createInstance } from '../../../tests/helpers/instances';

/** systemctl reports the server running and accepts everything else. */
function running() {
	invalidateUnitState();
	fakeProcesses((cmd, args) =>
		args.includes('show') ? { stdout: 'ActiveState=active\nSubState=running\nResult=success\n' } : {}
	);
}

const stops = () => spawnCalls.filter((c) => c.args.includes('stop') || c.args.includes('restart'));

describe('stop or restart after a countdown', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		running();
	});
	afterEach(() => vi.useRealTimers());

	it('acts when the countdown runs out, not before', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' }, { 'eula.txt': 'eula=true' });
		const result = await startCountdown(instance, 'restart', 300);
		expect(result.message).toMatch(/Restarting in 5 minutes/);
		expect(getCountdown(instance.id)).toMatchObject({ verb: 'restart' });
		await vi.advanceTimersByTimeAsync(299_000);
		expect(stops()).toEqual([]);
		await vi.advanceTimersByTimeAsync(2_000);
		// The restart writes unit files first: real I/O, which fake timers do not wait for.
		await vi.waitFor(() => expect(stops().length).toBeGreaterThan(0));
		expect(getCountdown(instance.id)).toBeNull();
	});

	it('does nothing once cancelled', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		await startCountdown(instance, 'stop', 60);
		expect(cancelCountdown(instance.id)).toBe(true);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(stops()).toEqual([]);
	});

	it('does not restart a server stopped in the meantime', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		await startCountdown(instance, 'restart', 60);
		invalidateUnitState();
		fakeProcesses((cmd, args) => (args.includes('show') ? { stdout: 'ActiveState=inactive\nSubState=dead\n' } : {}));
		await vi.advanceTimersByTimeAsync(61_000);
		expect(stops()).toEqual([]);
	});
});
