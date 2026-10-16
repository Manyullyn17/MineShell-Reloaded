import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyServerCap, capProblem, capWarning, getServerCap, inServerSlice, renderSliceUnit, saveServerCap, sliceUnitFile } from './servercap';
import { renderTemplateUnit, SERVER_SLICE } from './systemd';
import { startMemoryWarning } from './memoryguard';
import { TEMPLATE_UNIT, systemdUnitDir } from './config';
import { serverSliceName } from './unit-template.js';
import type { ServerInstance } from './db/schema';
import { fakeProcesses, spawnCalls } from '../../../tests/helpers/process';

const reloads = () => spawnCalls.filter((c) => c.args.join(' ') === '--user daemon-reload').length;

describe('the slice all servers share', () => {
	it('is the one systemd gives the template’s instances by default, escaped as systemd does', () => {
		// systemd 255 put minecraft@<id> into app-minecraft.slice on its own; a '-' would make a child slice.
		expect(serverSliceName('minecraft')).toBe('app-minecraft.slice');
		expect(serverSliceName('mstest-once')).toBe('app-mstest\\x2donce.slice');
		expect(renderTemplateUnit()).toContain(`\nSlice=${SERVER_SLICE}\n`);
	});

	it('tells a running server inside it from one outside it', () => {
		expect(inServerSlice(`/user.slice/user-1000.slice/user@1000.service/app.slice/${SERVER_SLICE}/x.service`)).toBe(true);
		expect(inServerSlice('/user.slice/user-1000.slice/user@1000.service/app.slice/x.service')).toBe(false);
		expect(inServerSlice('')).toBe(false);
	});
});

describe('the cap on all servers', () => {
	beforeEach(async () => {
		fakeProcesses(() => ({}));
		await fs.rm(systemdUnitDir(), { recursive: true, force: true });
		await fs.mkdir(systemdUnitDir(), { recursive: true });
		await fs.writeFile(path.join(systemdUnitDir(), TEMPLATE_UNIT), renderTemplateUnit());
		spawnCalls.length = 0;
	});

	it('is a soft memory cap and a CPU quota on the slice, and the file goes when both are cleared', async () => {
		expect(renderSliceUnit({ memoryMb: null, cpuPercent: null })).toBeNull();
		await applyServerCap({ memoryMb: 20480, cpuPercent: 600 });
		const body = await fs.readFile(sliceUnitFile(), 'utf8');
		// MemoryHigh throttles; MemoryMax would kill a server at the cap.
		expect(body).toContain('[Slice]\nMemoryHigh=20480M\nCPUQuota=600%\n');
		expect(body).not.toContain('MemoryMax');
		expect(reloads()).toBe(1);

		await applyServerCap({ memoryMb: 20480, cpuPercent: 600 });
		expect(reloads()).toBe(1);

		await applyServerCap({ memoryMb: null, cpuPercent: null });
		await expect(fs.access(sliceUnitFile())).rejects.toThrow();
		expect(reloads()).toBe(2);
		await applyServerCap({ memoryMb: null, cpuPercent: null });
		expect(reloads()).toBe(2);
	});

	it('leaves a slice unit it did not write alone', async () => {
		await fs.writeFile(sliceUnitFile(), '[Slice]\nMemoryMax=1G\n');
		await expect(applyServerCap({ memoryMb: 4096, cpuPercent: null })).rejects.toThrow(/not written by MineShell/);
		await expect(applyServerCap({ memoryMb: null, cpuPercent: null })).rejects.toThrow(/not written by MineShell/);
		expect(await fs.readFile(sliceUnitFile(), 'utf8')).toBe('[Slice]\nMemoryMax=1G\n');
	});

	it('writes nothing while the template unit is not installed', async () => {
		await fs.rm(path.join(systemdUnitDir(), TEMPLATE_UNIT));
		await applyServerCap({ memoryMb: 4096, cpuPercent: null });
		await expect(fs.access(sliceUnitFile())).rejects.toThrow();
		expect(reloads()).toBe(0);
	});

	it('is saved and read back, and refuses values outside the machine', () => {
		saveServerCap({ memoryMb: 8192, cpuPercent: null });
		expect(getServerCap()).toEqual({ memoryMb: 8192, cpuPercent: null });
		saveServerCap({ memoryMb: null, cpuPercent: null });
		expect(capProblem({ memoryMb: 512, cpuPercent: null })).toMatch(/memory cap/);
		expect(capProblem({ memoryMb: 10 ** 9, cpuPercent: null })).toMatch(/memory cap/);
		expect(capProblem({ memoryMb: null, cpuPercent: 5 })).toMatch(/CPU cap/);
		expect(capProblem({ memoryMb: 2048, cpuPercent: 100 })).toBeNull();
	});
});

describe('starting past the cap', () => {
	it('warns when the new server and the running ones together can take more than the cap', () => {
		expect(capWarning({ name: 'b', needMb: 4096, capMb: 16384, running: [{ name: 'a', ceilingMb: 8192 }] })).toBeNull();
		const warning = capWarning({ name: 'b', needMb: 9216, capMb: 16384, running: [{ name: 'a', ceilingMb: 8192 }] });
		expect(warning).toContain('b can take up to 9.0 GB and a up to 8.0 GB, past the 16.0 GB cap');
	});

	it('is part of the start check, with the running servers’ heaps', async () => {
		const server = (id: string, memoryMaxMb: number) =>
			({ id, name: id, memoryMaxMb, jvmArgs: '', limitMemoryMb: null }) as unknown as ServerInstance;
		// No such process: its heap comes from the saved settings (1 GB -> 1.1 + 1 GB = 2150 MB at most).
		const others = [{ instance: server('a', 1024), mainPid: 2 ** 30 }];
		expect(await startMemoryWarning(server('b', 256), others, 8192)).toBeNull();
		expect(await startMemoryWarning(server('b', 256), others, 2048)).toContain('cap on all servers together');
		expect(await startMemoryWarning(server('b', 256), others, null)).toBeNull();
	});
});
