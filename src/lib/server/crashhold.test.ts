import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from '../../../tests/helpers/instances';
import { fakeProcesses, spawnCalls } from '../../../tests/helpers/process';

// A real crash: Chunky without Fabric API (tests/tools/scenarios.sh missing-dep), as the journal gives a run.
const crash = await fs.readFile(path.resolve('tests/crashdiag/fixtures/fabric-0.20-oldfabricid.log'), 'utf8');
const journal = vi.hoisted(() => ({ log: '' }));
vi.mock('#lib/server/journal.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/journal.js')>()),
	readLastRun: async () => journal.log
}));
const { holdFixableRestart } = await import('./crashhold');
const { restartHeldAt } = await import('./history');

const started = 'Started mstest@x.service - Minecraft server (x) managed by MineShell.\n';
const stops = () => spawnCalls.filter((c) => c.args.includes('stop'));

describe('a crash restart that would only fail again', () => {
	beforeEach(() => {
		fakeProcesses(() => ({}));
		journal.log = started + crash;
	});

	// systemd restarted it up to the limit, each start failing the same way, before the
	// crash and its "Install Fabric API" could be used.
	it('is cancelled for a crash while starting that has a fix, once per run', async () => {
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.20.1' });
		expect(await holdFixableRestart(instance.id, 'run-1')).toBe(true);
		expect(stops()).toHaveLength(1);
		expect(restartHeldAt(instance.id)).not.toBeNull();
		expect(await holdFixableRestart(instance.id, 'run-1')).toBe(false);
		expect(stops()).toHaveLength(1);
	});

	it("is cancelled where systemd's Started line names only the description (systemd 249, Ubuntu 22.04)", async () => {
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.20.1' });
		journal.log = 'Started Minecraft server (x) managed by MineShell.\n' + crash;
		expect(await holdFixableRestart(instance.id, 'run-1')).toBe(true);
		expect(stops()).toHaveLength(1);
	});

	it('is let happen with the setting off, or for a crash after the server was up', async () => {
		const off = await createInstance({ modloader: 'fabric', minecraftVersion: '1.20.1', crashRestartSkipFixable: false });
		expect(await holdFixableRestart(off.id, 'run-1')).toBe(false);
		const up = await createInstance({ modloader: 'fabric', minecraftVersion: '1.20.1' });
		journal.log = started + '[10:00:00] [Server thread/INFO]: Done (3.1s)! For help, type "help"\n' + crash;
		expect(await holdFixableRestart(up.id, 'run-1')).toBe(false);
		expect(stops()).toHaveLength(0);
		expect(restartHeldAt(up.id)).toBeNull();
	});
});
