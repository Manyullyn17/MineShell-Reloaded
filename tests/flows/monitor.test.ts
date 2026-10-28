import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sampleResources, recentSamples } = await import('#lib/server/monitor.js');
const { db } = await import('#lib/server/db/index.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { createInstance } = await import('../helpers/instances');
const { fakeProcesses } = await import('../helpers/process');

let cpuNsec = 0;
function running() {
	fakeProcesses((cmd, args) => {
		if (cmd === 'systemctl' && args.includes('show')) {
			return { stdout: `ActiveState=active\nSubState=running\nCPUUsageNSec=${cpuNsec}\nMemoryCurrent=1048576\n` };
		}
		return {};
	});
}

// Two rounds in the same millisecond have no elapsed time, and the second stores nothing.
function nextRound() {
	cpuNsec += 5e9;
	vi.setSystemTime(Date.now() + 10_000);
	invalidateUnitState();
}

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('CPU and memory sampling', () => {
	it('stores a sample from the second round on', async () => {
		const s = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' });
		running();
		await sampleResources();
		nextRound();
		await sampleResources();
		expect(recentSamples(s.id)).toHaveLength(1);
		expect(recentSamples(s.id)[0].memoryBytes).toBe(1048576);
	});

	it('does not reject when the database refuses the sample (a full disk)', async () => {
		await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' });
		running();
		await sampleResources();
		nextRound();
		vi.spyOn(db, 'insert').mockImplementation(() => {
			throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		// A rejection here goes nowhere in MineShell: nothing awaits the timer, and Node ends the process.
		await expect(sampleResources()).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('sampling CPU and memory failed'), 'database or disk is full');
	});
});
