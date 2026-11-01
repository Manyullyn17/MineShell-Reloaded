import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	forgetSandboxProbe,
	invalidateUnitState,
	refreshTemplateUnit,
	renderSandboxDropIn,
	renderTemplateUnit,
	startUnit,
	unitState,
	writeResourceLimits,
	writeRestartPolicy,
	writeSandbox,
	writeUnitEnv
} from './systemd';
import { DATA_DIR, TEMPLATE_UNIT, UNITS_DIR, instanceDir, systemdUnitDir, unitName } from './config';
import { readJournal } from './journal';
import { splitArgs } from './shellargs';
import { fakeProcesses, spawnCalls } from '../../../tests/helpers/process';

const SHOW_RUNNING = [
	'ActiveState=active',
	'SubState=running',
	'ActiveEnterTimestampMonotonic=5000000',
	'CPUUsageNSec=123456789',
	'MemoryCurrent=2147483648',
	'MainPID=4321',
	'NRestarts=2',
	'Result=success'
].join('\n');

describe('unitState', () => {
	beforeEach(() => invalidateUnitState());

	it('parses systemctl show output', async () => {
		fakeProcesses(() => ({ stdout: SHOW_RUNNING }));
		const state = await unitState('alpha');
		expect(state).toMatchObject({
			active: 'active',
			sub: 'running',
			cpuUsageNsec: 123456789,
			memoryBytes: 2147483648,
			mainPid: 4321,
			nRestarts: 2,
			result: 'success'
		});
		// Monotonic 5s after boot -> a real wall-clock time in the past.
		expect(state.activeEnterTimestamp).toBeGreaterThan(0);
		expect(state.activeEnterTimestamp).toBeLessThanOrEqual(Date.now());
		expect(spawnCalls[0].args).toContain(unitName('alpha'));
	});

	it('treats [not set] and infinity as zero', async () => {
		fakeProcesses(() => ({ stdout: 'ActiveState=inactive\nSubState=dead\nMemoryCurrent=[not set]\nCPUUsageNSec=infinity\nActiveEnterTimestampMonotonic=0\nResult=exit-code' }));
		expect(await unitState('beta')).toMatchObject({ active: 'inactive', memoryBytes: 0, cpuUsageNsec: 0, activeEnterTimestamp: 0, result: 'exit-code' });
	});

	it('reports unknown when systemctl fails without output', async () => {
		fakeProcesses(() => ({ code: 1, stderr: 'Failed to connect to bus' }));
		expect(await unitState('gamma')).toMatchObject({ active: 'unknown', sub: 'unknown', result: 'unknown' });
	});

	it('shares one systemctl call between quick repeated reads', async () => {
		fakeProcesses(() => ({ stdout: SHOW_RUNNING }));
		await Promise.all([unitState('delta'), unitState('delta'), unitState('delta')]);
		expect(spawnCalls).toHaveLength(1);
		await unitState('delta', { fresh: true });
		expect(spawnCalls).toHaveLength(2);
		invalidateUnitState('delta');
		await unitState('delta');
		expect(spawnCalls).toHaveLength(3);
	});
});

describe('unit files', () => {
	it("runs systemctl and journalctl as the user's own, never through sudo", async () => {
		fakeProcesses(() => ({}));
		await startUnit('epsilon');
		await readJournal('epsilon', 5);
		expect(spawnCalls.map((c) => [c.cmd, ...c.args.slice(0, 2)])).toEqual([
			['systemctl', '--user', 'start'],
			['journalctl', '--user', `--user-unit=${unitName('epsilon')}`]
		]);
	});

	it('writes nothing into the systemd folder while the template unit is not installed', async () => {
		fakeProcesses(() => ({}));
		// The unit folder is shared by the whole run; another test may have installed it.
		await fs.rm(path.join(systemdUnitDir(), TEMPLATE_UNIT), { force: true });
		await writeRestartPolicy('eta', true, 3, 600);
		await expect(fs.access(path.join(systemdUnitDir(), `${unitName('eta')}.d`))).rejects.toThrow();
		expect(spawnCalls).toEqual([]);
	});

	it('writes the restart policy as a drop-in and reloads systemd', async () => {
		fakeProcesses(() => ({}));
		await fs.mkdir(systemdUnitDir(), { recursive: true });
		await fs.writeFile(path.join(systemdUnitDir(), TEMPLATE_UNIT), renderTemplateUnit());
		await writeRestartPolicy('epsilon', true, 3, 600);
		const file = await fs.readFile(path.join(systemdUnitDir(), `${unitName('epsilon')}.d`, 'restart.conf'), 'utf8');
		expect(file).toContain('Restart=on-failure');
		expect(file).toContain('StartLimitBurst=3');
		expect(file).toContain('StartLimitIntervalSec=600');
		expect(spawnCalls.map((c) => c.args.join(' '))).toContain('--user daemon-reload');

		await writeRestartPolicy('epsilon', false, 3, 600);
		expect(await fs.readFile(path.join(systemdUnitDir(), `${unitName('epsilon')}.d`, 'restart.conf'), 'utf8')).toContain('Restart=no');
	});

	it('writes memory and CPU caps as a drop-in, and removes it when both are cleared', async () => {
		fakeProcesses(() => ({}));
		await fs.mkdir(systemdUnitDir(), { recursive: true });
		await fs.writeFile(path.join(systemdUnitDir(), TEMPLATE_UNIT), renderTemplateUnit());
		const file = path.join(systemdUnitDir(), `${unitName('theta')}.d`, 'limits.conf');
		await writeResourceLimits('theta', { memoryMb: 6144, cpuPercent: 200 });
		const body = await fs.readFile(file, 'utf8');
		expect(body).toContain('MemoryMax=6144M');
		expect(body).toContain('CPUQuota=200%');

		await writeResourceLimits('theta', { memoryMb: null, cpuPercent: 150 });
		expect(await fs.readFile(file, 'utf8')).not.toContain('MemoryMax');

		spawnCalls.length = 0;
		await writeResourceLimits('theta', { memoryMb: null, cpuPercent: 150 });
		// Unchanged: no reload.
		expect(spawnCalls).toEqual([]);

		await writeResourceLimits('theta', { memoryMb: null, cpuPercent: null });
		await expect(fs.access(file)).rejects.toThrow();
	});

	/**
	 * What the start line gets from a value in <id>.env: systemd takes the double quotes and
	 * the backslash escapes in them, then the shell's eval splits what is left as splitArgs
	 * does. Tried for real with a user unit (2026-10-31): spaces, quotes, $, a backslash, *, ;
	 * and an empty argument all came through as written.
	 */
	const started = (value: string) => {
		expect(value).toMatch(/^".*"$/);
		return splitArgs(value.slice(1, -1).replace(/\\([\\"])/g, '$1'));
	};
	const envValue = (env: string, key: string) => env.match(new RegExp(`^${key}=(.*)$`, 'm'))![1];

	it('writes the environment file the template unit reads', async () => {
		await writeUnitEnv('zeta', { java: '/usr/bin/java', jvmArgs: '-Xmx2G', launchArgs: '-jar server.jar nogui' });
		const env = await fs.readFile(path.join(UNITS_DIR, 'zeta.env'), 'utf8');
		expect(env).toContain('MS_JAVA=/usr/bin/java');
		expect(started(envValue(env, 'MS_JVM_ARGS'))).toEqual(['-Xmx2G']);
		expect(started(envValue(env, 'MS_LAUNCH_ARGS'))).toEqual(['-jar', 'server.jar', 'nogui']);
	});

	// The start line split on spaces only, so a quote reached Java as part of the value:
	// `-Dx="a b"` was two broken arguments, and saving had to refuse quotes.
	it('keeps an argument holding a space, or quotes, $ and backslashes, whole', async () => {
		const jvmArgs = `-Xmx4G "-Dmotd=Hello world" -Dq='it'"'"'s' -Dp=$HOME '-Dbs=C:\\games' -Dglob=* ''`;
		await writeUnitEnv('zeta', { java: '/usr/bin/java', jvmArgs, launchArgs: '-jar server.jar nogui\nMS_JAVA=/bin/false' });
		const env = await fs.readFile(path.join(UNITS_DIR, 'zeta.env'), 'utf8');
		expect(started(envValue(env, 'MS_JVM_ARGS'))).toEqual(['-Xmx4G', '-Dmotd=Hello world', "-Dq=it's", '-Dp=$HOME', '-Dbs=C:\\games', '-Dglob=*', '']);
		// A line break would start a line of its own, setting whatever it says.
		expect(started(envValue(env, 'MS_LAUNCH_ARGS'))).toEqual(['-jar', 'server.jar', 'nogui', 'MS_JAVA=/bin/false']);
		expect(env.match(/^MS_JAVA=/gm)).toHaveLength(1);
	});

	it('starts a value saved with a quote left open as it always did, split on spaces', async () => {
		await writeUnitEnv('zeta', { java: '/usr/bin/java', jvmArgs: '-Xmx2G -Dx="open', launchArgs: '-jar server.jar nogui' });
		const env = await fs.readFile(path.join(UNITS_DIR, 'zeta.env'), 'utf8');
		expect(started(envValue(env, 'MS_JVM_ARGS'))).toEqual(['-Xmx2G', '-Dx="open']);
	});

	it('counts the exit code of a SIGTERM stop as a clean exit', () => {
		// The JVM exits 128 + 15 after saving; without this every stop was logged as a failure.
		expect(renderTemplateUnit()).toMatch(/^SuccessExitStatus=143$/m);
	});

	it('brings an installed template from an older MineShell up to date, and leaves one it did not write', async () => {
		fakeProcesses(() => ({}));
		const file = path.join(systemdUnitDir(), TEMPLATE_UNIT);
		await fs.mkdir(systemdUnitDir(), { recursive: true });
		await fs.writeFile(file, '# Managed by MineShell.\n[Service]\nKillSignal=SIGTERM\n');
		expect(await refreshTemplateUnit()).toBe(true);
		expect(await fs.readFile(file, 'utf8')).toContain('SuccessExitStatus=143');
		expect(spawnCalls.map((c) => c.args.join(' '))).toContain('--user daemon-reload');
		expect(await refreshTemplateUnit()).toBe(false);

		await fs.writeFile(file, '# my own unit\n[Service]\n');
		expect(await refreshTemplateUnit()).toBe(false);
		expect(await fs.readFile(file, 'utf8')).toBe('# my own unit\n[Service]\n');
	});

	it('is the one template npm run setup writes too', async () => {
		// setup.mjs had its own copy, which lacked SuccessExitStatus=143 and drifted further with every change.
		const setup = await fs.readFile(path.join(process.cwd(), 'scripts', 'setup.mjs'), 'utf8');
		expect(setup).toContain("from '../src/lib/server/unit-template.js'");
		expect(setup).not.toMatch(/ExecStart=|\[Service\]/);
	});

	// Mod code runs as the account MineShell runs as: the template keeps it from what needs
	// no namespaces to forbid (new privileges, namespaces of its own, privileged system calls).
	it('sandboxes the server with options a user unit gets everywhere', () => {
		const unit = renderTemplateUnit();
		// @chown after ~@privileged: without it the JVM's attach listener fails, and heap readings with it.
		for (const line of ['NoNewPrivileges=yes', 'RestrictNamespaces=yes', 'SystemCallFilter=@system-service', 'SystemCallFilter=~@privileged', 'SystemCallFilter=@chown', 'SystemCallErrorNumber=EPERM', 'PrivateTmp=yes']) {
			expect(unit).toMatch(new RegExp(`^${line.replace(/[+@~]/g, '\\$&')}$`, 'm'));
		}
		// The JIT writes code it then runs.
		expect(unit).not.toContain('MemoryDenyWriteExecute');
	});

	it('launches through the env file from the instance folder', () => {
		const unit = renderTemplateUnit();
		expect(unit).toContain('EnvironmentFile=');
		expect(unit).toContain('$MS_JAVA');
		expect(unit).toMatch(/WorkingDirectory=.*%i/);
	});

	// Forge 1.12's startup question is answered by -Dfml.queryResult=confirm for
	// one start (forgequery.ts); a restart after a crash must not get it again.
	it('takes one start’s JVM arguments from once/<id>/args and deletes it', () => {
		const exec = renderTemplateUnit().match(/^ExecStart=(.*)$/m)![1];
		// A folder per server: the only part of units/ its sandbox lets it see.
		expect(exec).toContain(`f="${UNITS_DIR}/once/%i/args"`);
		expect(exec).toContain('a=$(cat "$f"); rm -f "$f"');
		expect(exec).toContain('eval "set -- $MS_JVM_ARGS $a $MS_LAUNCH_ARGS"; exec "$MS_JAVA" "$@"');
		// systemd substitutes ${VAR} even inside a quoted word, before the shell sees it.
		expect(exec).not.toContain('${');
	});
});

describe('a unit’s memory', () => {
	it('leaves out the page cache the kernel can drop', async () => {
		const { workingSet } = await import('./systemd');
		// A render read gigabytes of region files: cached, not held.
		const stat = 'anon 1922000000\nfile 17900000000\ninactive_file 4000000000\nactive_file 20000000\nshmem 17179869184\n';
		expect(workingSet(23_000_000_000, stat)).toBe(19_000_000_000);
		expect(workingSet(5_000_000_000, null)).toBe(5_000_000_000);
		expect(workingSet(1000, 'inactive_file 5000\n')).toBe(0);
	});
});

describe('a server’s sandbox drop-in', () => {
	const paths = { instanceDir: '/srv/ms/instances/a', onceDir: '/srv/ms/units/once/a', javaHome: '/usr/lib/jvm/java-21' };

	// ProtectHome= hides a data folder in the home folders; one elsewhere stayed readable
	// (ProtectSystem=strict only makes it read-only), database and secret.key included.
	it('empties a data folder outside the home folders, giving back the server’s own parts', () => {
		const outside = renderSandboxDropIn({ ...paths, dataDir: '/srv/ms' });
		expect(outside).toContain('TemporaryFileSystem=/srv/ms:ro\n');
		expect(outside).toContain('BindPaths=/srv/ms/instances/a\n');
		expect(outside).toContain('BindPaths=-/srv/ms/units/once/a\n');
		expect(renderSandboxDropIn({ ...paths, dataDir: '/home/u/.local/share/mineshell' })).not.toContain('TemporaryFileSystem');
	});

	it('warns about a link out of the server folder, which leads nowhere inside', async () => {
		await fs.mkdir(systemdUnitDir(), { recursive: true });
		await fs.writeFile(path.join(systemdUnitDir(), TEMPLATE_UNIT), renderTemplateUnit());
		forgetSandboxProbe();
		// A transient unit in a mount namespace of its own: the sandbox works here.
		fakeProcesses((cmd) => (cmd === 'systemd-run' ? { stdout: 'mnt:[1]\n' } : {}));
		const dir = instanceDir('sbx-link');
		await fs.mkdir(path.join(dir, 'mods'), { recursive: true });
		await fs.symlink(DATA_DIR, path.join(dir, 'world'));
		await fs.symlink('mods', path.join(dir, 'inside'));
		const { warning } = await writeSandbox('sbx-link', { instanceDir: dir, javaPath: null });
		expect(warning).toMatch(/^world is a link out of the server folder/);
		await fs.rm(path.join(dir, 'world'));
		expect((await writeSandbox('sbx-link', { instanceDir: dir, javaPath: null })).warning).toBeNull();
		forgetSandboxProbe();
	});
});
