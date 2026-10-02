import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	invalidateUnitState,
	renderTemplateUnit,
	scopedCommand,
	unitState,
	writeRestartPolicy,
	writeUnitEnv
} from './systemd';
import { UNITS_DIR, systemdUnitDir, unitName } from './config';
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

	it('writes the restart policy as a drop-in and reloads systemd', async () => {
		fakeProcesses(() => ({}));
		await writeRestartPolicy('epsilon', true, 3, 600);
		const file = await fs.readFile(path.join(systemdUnitDir(), `${unitName('epsilon')}.d`, 'restart.conf'), 'utf8');
		expect(file).toContain('Restart=on-failure');
		expect(file).toContain('StartLimitBurst=3');
		expect(file).toContain('StartLimitIntervalSec=600');
		expect(spawnCalls.map((c) => c.args.join(' '))).toContain('--user daemon-reload');

		await writeRestartPolicy('epsilon', false, 3, 600);
		expect(await fs.readFile(path.join(systemdUnitDir(), `${unitName('epsilon')}.d`, 'restart.conf'), 'utf8')).toContain('Restart=no');
	});

	it('writes the environment file the template unit reads', async () => {
		await writeUnitEnv('zeta', { java: '/usr/bin/java', jvmArgs: '-Xmx2G', launchArgs: '-jar server.jar nogui' });
		const env = await fs.readFile(path.join(UNITS_DIR, 'zeta.env'), 'utf8');
		expect(env).toContain('MS_JAVA=/usr/bin/java');
		expect(env).toContain('MS_JVM_ARGS=-Xmx2G');
		expect(env).toContain('MS_LAUNCH_ARGS=-jar server.jar nogui');
	});

	it('launches through the env file from the instance folder', () => {
		const unit = renderTemplateUnit();
		expect(unit).toContain('EnvironmentFile=');
		expect(unit).toContain('$MS_JAVA');
		expect(unit).toMatch(/WorkingDirectory=.*%i/);
	});
});
