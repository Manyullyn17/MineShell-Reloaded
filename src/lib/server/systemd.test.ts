import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	invalidateUnitState,
	refreshTemplateUnit,
	renderTemplateUnit,
	scopedCommand,
	unitState,
	writeResourceLimits,
	writeRestartPolicy,
	writeUnitEnv
} from './systemd';
import { TEMPLATE_UNIT, UNITS_DIR, systemdUnitDir, unitName } from './config';
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
	it('scopes systemctl to the user session by default', () => {
		expect(scopedCommand('systemctl', ['start', 'x'])).toEqual(['systemctl', '--user', 'start', 'x']);
		expect(scopedCommand('journalctl', ['-n', '5'])).toEqual(['journalctl', '-n', '5']);
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

	it('writes the environment file the template unit reads', async () => {
		await writeUnitEnv('zeta', { java: '/usr/bin/java', jvmArgs: '-Xmx2G', launchArgs: '-jar server.jar nogui' });
		const env = await fs.readFile(path.join(UNITS_DIR, 'zeta.env'), 'utf8');
		expect(env).toContain('MS_JAVA=/usr/bin/java');
		expect(env).toContain('MS_JVM_ARGS=-Xmx2G');
		expect(env).toContain('MS_LAUNCH_ARGS=-jar server.jar nogui');
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

	it('launches through the env file from the instance folder', () => {
		const unit = renderTemplateUnit();
		expect(unit).toContain('EnvironmentFile=');
		expect(unit).toContain('$MS_JAVA');
		expect(unit).toMatch(/WorkingDirectory=.*%i/);
	});
});
