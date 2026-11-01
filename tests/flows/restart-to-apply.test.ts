import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const { summarise } = await import('#lib/server/instances.js');
const { invalidateUnitState, writeUnitEnv } = await import('#lib/server/systemd.js');
const { systemdUnitDir, TEMPLATE_UNIT, unitEnvFile, unitName } = await import('#lib/server/config.js');
const { createInstance } = await import('../helpers/instances');
const { fakeProcesses } = await import('../helpers/process');

/** systemd: running, its process started `mainUs` after boot. */
function runningSince(mainUs: number) {
	invalidateUnitState();
	fakeProcesses((cmd, args) => {
		if (cmd === 'systemctl' && args.includes('show'))
			return { stdout: `ActiveState=active\nSubState=running\nActiveEnterTimestampMonotonic=${mainUs}\nExecMainStartTimestampMonotonic=${mainUs}\nResult=success\n` };
		return {};
	});
}

const env = { java: '/usr/bin/java', jvmArgs: '-Xmx4G', launchArgs: 'nogui' };

/**
 * A server keeps running with the settings it started with: after a MineShell update gave
 * servers a sandbox, one running since before still had none, and nothing said so.
 */
describe('a server running since before its start settings changed', () => {
	it('is flagged until it restarts, and a MineShell restart writing the same settings flags nothing', async () => {
		const s = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		runningSince(1_000_000);
		const bootAt = (await summarise(s)).state.mainStartedAt - 1000;

		// Written now, long after a process that started a second after boot.
		await writeUnitEnv(s.id, env);
		expect((await summarise(s)).restartToApply).toBe(true);

		// Started after the change: nothing to apply.
		runningSince((Date.now() - bootAt + 5000) * 1000);
		expect((await summarise(s)).restartToApply).toBe(false);

		// The same settings written again (every MineShell start rewrites them) keep the file's time.
		// Every file the check reads made old: an earlier test file in this worker (they share its
		// unit folder) may have written the template unit just now.
		const old = new Date(bootAt + 500);
		const files = [unitEnvFile(s.id), path.join(systemdUnitDir(), TEMPLATE_UNIT), path.join(systemdUnitDir(), `${unitName(s.id)}.d`, 'sandbox.conf')];
		for (const file of files) await fs.utimes(file, old, old).catch(() => {});
		await writeUnitEnv(s.id, env);
		runningSince(1_000_000);
		expect((await summarise(s)).restartToApply).toBe(false);
		await writeUnitEnv(s.id, { ...env, jvmArgs: '-Xmx6G' });
		expect((await summarise(s)).restartToApply).toBe(true);
	});
});
