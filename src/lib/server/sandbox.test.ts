import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetSandboxState, renderSandboxDropIn, sandboxProperties, sandboxState, writeSandbox } from './sandbox';
import { renderTemplateUnit } from './systemd';
import { DATA_DIR, KEY_PATH, TEMPLATE_UNIT, instanceDir, systemdUnitDir, unitName } from './config';
import { fakeProcesses, spawnCalls } from '../../../tests/helpers/process';

/** systemd-run as on a machine where the sandbox works: the script runs, and writes into its folder. */
const sandboxWorks = () =>
	fakeProcesses((cmd, args) => {
		if (cmd === 'systemd-run') fs.writeFileSync(path.join(path.dirname(args[args.length - 1]), 'written'), '');
		return {};
	});

const dropIn = (id: string) => path.join(systemdUnitDir(), `${unitName(id)}.d`, 'sandbox.conf');

async function installTemplate() {
	await fsp.mkdir(systemdUnitDir(), { recursive: true });
	await fsp.writeFile(path.join(systemdUnitDir(), TEMPLATE_UNIT), renderTemplateUnit());
}

describe('the servers’ sandbox', () => {
	beforeEach(() => forgetSandboxState());

	it('hides the home folders and the system, and shows the server its folder and Java', () => {
		const props = sandboxProperties({ serverDir: '/home/u/.local/share/mineshell/instances/a', javaHomes: ['/opt/jdk-21'], dataDir: '/home/u/.local/share/mineshell' });
		const text = renderSandboxDropIn(props);
		expect(text).toContain('ProtectSystem=strict\n');
		// /run/user too: the user manager's sockets would let a mod start any program unsandboxed.
		expect(text).toContain('ProtectHome=tmpfs\n');
		expect(text).toContain('BindPaths=/home/u/.local/share/mineshell/instances/a\n');
		expect(text).toContain('BindReadOnlyPaths=-/opt/jdk-21\n');
		expect(text).not.toContain('TemporaryFileSystem');
		// A data folder outside the home folders is emptied the same way.
		expect(renderSandboxDropIn(sandboxProperties({ serverDir: '/srv/ms/instances/a', javaHomes: [], dataDir: '/srv/ms' }))).toContain(
			'TemporaryFileSystem=/srv/ms:ro\n'
		);
	});

	it('is used once a throwaway unit with the same settings proves it works', async () => {
		sandboxWorks();
		expect(await sandboxState()).toMatchObject({ on: true });
		const call = spawnCalls.find((c) => c.cmd === 'systemd-run')!;
		expect(call.args).toEqual(expect.arrayContaining(['--user', '--wait', '-p', 'ProtectHome=tmpfs', '-p', 'ProtectSystem=strict']));
		// What the test unit must not see.
		const script = await fsp.readFile(call.args[call.args.length - 1], 'utf8').catch(() => null);
		expect(script).toBeNull(); // removed afterwards
	});

	it('is left out where systemd cannot build it, or the test unit still sees MineShell’s key', async () => {
		fakeProcesses((cmd) => (cmd === 'systemd-run' ? { code: 226, stderr: 'Failed to set up mount namespacing: Permission denied' } : {}));
		expect(await sandboxState()).toMatchObject({ on: false, reason: expect.stringContaining('Permission denied') });

		forgetSandboxState();
		fakeProcesses((cmd, args) => {
			if (cmd !== 'systemd-run') return {};
			const script = fs.readFileSync(args[args.length - 1], 'utf8');
			expect(script).toContain(KEY_PATH);
			return { code: 11 };
		});
		expect(await sandboxState()).toMatchObject({ on: false, reason: expect.stringContaining(KEY_PATH) });
	});

	it('is written as each server’s drop-in, and removed again when it stops working', async () => {
		await installTemplate();
		sandboxWorks();
		await writeSandbox('sbx', '/usr/bin/java');
		const body = await fsp.readFile(dropIn('sbx'), 'utf8');
		expect(body).toContain(`BindPaths=${instanceDir('sbx')}\n`);
		expect(body).toContain(`BindReadOnlyPaths=-${path.join(DATA_DIR, 'java')}\n`);

		forgetSandboxState();
		fakeProcesses((cmd) => (cmd === 'systemd-run' ? { code: 1 } : {}));
		await writeSandbox('sbx', '/usr/bin/java');
		expect(fs.existsSync(dropIn('sbx'))).toBe(false);
	});

	it('warns about a link out of the server folder, which the server will not see', async () => {
		await installTemplate();
		sandboxWorks();
		const dir = instanceDir('sbx-link');
		await fsp.mkdir(dir, { recursive: true });
		await fsp.symlink(DATA_DIR, path.join(dir, 'world'));
		expect((await writeSandbox('sbx-link', '/usr/bin/java')).warning).toContain('world links out of the server folder');
	});
});
