import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mcmodInfo, writeJar } from '../../../tests/helpers/fs';
import { createInstance } from '../../../tests/helpers/instances';

const crashLog = await fs.readFile(path.resolve('tests/crashdiag/fixtures/cleanroom-0.4.4-clientcode.log'), 'utf8');
vi.mock('#lib/server/journal.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/journal.js')>()),
	readLastRun: async () => crashLog
}));
const { likelyCause } = await import('./lastcrash');
type Summary = import('./instances').InstanceSummary;
type Instance = Awaited<ReturnType<typeof createInstance>>;

/** What summarise() reports, without asking systemd. */
const summary = (instance: Instance, active: string, running = false): Summary => ({
	instance,
	running,
	uptimeMs: 0,
	javaWarning: null,
	eulaAccepted: true,
	state: { active, sub: active === 'failed' ? 'failed' : 'running', result: 'exit-code', activeEnterTimestamp: 0, cpuUsageNsec: 0, memoryBytes: 0, mainPid: 0, nRestarts: 0 } as Summary['state']
});

describe('likelyCause', () => {
	// The server list shows one line per crashed server, from the same
	// diagnosis the overview shows in full.
	it('names the mod that stopped the server', async () => {
		const instance = await createInstance({ modloader: 'cleanroom', minecraftVersion: '1.12.2' });
		await writeJar(path.join(instance.path, 'mods'), 'mstest-legacy-clientcode.jar', {
			'mcmod.info': mcmodInfo('mstest_clientcode', 'MineShell Test ClientCode'),
			'mstest/legacy/ClientCode.class': 'x'
		});
		expect(await likelyCause(summary(instance, 'failed'))).toMatch(/ClientCode/);
	});

	it('says nothing for a server that is running', async () => {
		const instance = await createInstance({ modloader: 'cleanroom', minecraftVersion: '1.12.2' });
		expect(await likelyCause(summary(instance, 'active', true))).toBeNull();
	});
});
