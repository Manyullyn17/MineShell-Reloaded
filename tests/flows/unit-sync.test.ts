import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncUnit } from '#lib/server/instances.js';
import { TEMPLATE_UNIT, systemdUnitDir, unitName, unitOnceDir } from '#lib/server/config.js';
import { forgetSandboxProbe, installTemplateUnit } from '#lib/server/systemd.js';
import { createInstance } from '../helpers/instances';
import { fakeProcesses, spawnCalls } from '../helpers/process';

describe('writing a server’s unit files', () => {
	// The env file went over to quoted arguments while a running dev server's template still
	// had the old start line (it is refreshed at boot only): Java got the quotes.
	it('brings an outdated template up to date before writing the env file the new way', async () => {
		fakeProcesses(() => ({}));
		const file = path.join(systemdUnitDir(), TEMPLATE_UNIT);
		await fs.mkdir(systemdUnitDir(), { recursive: true });
		await fs.writeFile(file, `# Managed by MineShell.\n[Service]\nExecStart=/bin/sh -c 'exec "$MS_JAVA" $MS_JVM_ARGS $MS_LAUNCH_ARGS'\n`);
		await syncUnit(await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' }));
		expect(await fs.readFile(file, 'utf8')).toContain('eval "set -- $MS_JVM_ARGS $a $MS_LAUNCH_ARGS"');
		expect(spawnCalls.map((c) => c.args.join(' '))).toContain('--user daemon-reload');
	});

	describe('the sandbox', () => {
		afterEach(forgetSandboxProbe);
		const dropIn = (id: string) => path.join(systemdUnitDir(), `${unitName(id)}.d`, 'sandbox.conf');
		/** systemd-run's probe answers with its own mount namespace, `own` or another. */
		const probing = (separate: boolean) => {
			forgetSandboxProbe();
			fakeProcesses((cmd) => (cmd === 'systemd-run' ? { stdout: separate ? 'mnt:[4026599999]\n' : '' } : {}));
		};

		// A server could read and write everything the account can: MineShell's database and
		// key, other servers' folders and env files, ~/.ssh.
		it('keeps a server to its own folder where systemd can make the namespaces', async () => {
			probing(true);
			await installTemplateUnit();
			const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
			await syncUnit(instance);
			const conf = await fs.readFile(dropIn(instance.id), 'utf8');
			expect(conf).toMatch(/^ProtectSystem=strict$/m);
			expect(conf).toMatch(/^ProtectHome=tmpfs$/m);
			expect(conf).toContain(`\nBindPaths=${instance.path}\n`);
			expect(conf).toContain(`\nBindPaths=-${unitOnceDir(instance.id)}\n`);
			await expect(fs.stat(unitOnceDir(instance.id))).resolves.toBeTruthy();
			expect(spawnCalls.filter((c) => c.cmd === 'systemd-run')).toHaveLength(1);
		});

		// There ProtectHome= and the like fail the start (218/CAPABILITIES) or are dropped unsaid.
		it('writes none, and removes one, where it cannot', async () => {
			probing(true);
			await installTemplateUnit();
			const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
			await syncUnit(instance);
			probing(false);
			await syncUnit(instance);
			await expect(fs.access(dropIn(instance.id))).rejects.toThrow();
		});
	});
});
