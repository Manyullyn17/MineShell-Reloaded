import { cpus } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The heap a running server started with, which a test has no Java to read from.
const heap = vi.hoisted(() => ({ runningMb: null as number | null }));
vi.mock('#lib/server/heap.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/heap.js')>()),
	runningHeapMb: async () => heap.runningMb
}));

const { actions } = await import('./+page.server');
const { listScheduledCommands } = await import('#lib/server/scheduledcommands.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { minMemoryLimitMb } = await import('#lib/shared/memorylimit.js');
const { createInstance, reload, systemdStopped } = await import('../../../../../tests/helpers/instances');
const { fakeProcesses, resetProcesses } = await import('../../../../../tests/helpers/process');
const { post: postTo } = await import('../../../../../tests/helpers/routes');

afterEach(() => {
	resetProcesses();
	heap.runningMb = null;
});

/** What a server's Settings refuses before saving: values that would break the server or never run. */

const post = (action: unknown, id: string, fields: Record<string, string>) => postTo(action, { params: { id }, fields });
const server = () => createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', memoryMaxMb: 4096, limitMemoryMb: null, limitCpuPercent: null });

describe('resource limits', () => {
	it('leave Java room above its heap', async () => {
		systemdStopped();
		const instance = await server();
		const floor = minMemoryLimitMb(4096);
		expect(await post(actions.limits, instance.id, { limitMemoryMb: String(floor - 1), limitCpuPercent: '' })).toMatchObject({
			status: 400,
			data: { message: expect.stringMatching(new RegExp(`^The memory limit has to leave Java room above its 4096 MB heap: at least ${floor} MB`)) }
		});
		expect(await post(actions.limits, instance.id, { limitMemoryMb: '6000.5', limitCpuPercent: '' })).toMatchObject({ status: 400 });
		expect(reload(instance.id).limitMemoryMb).toBeNull();
		expect(await post(actions.limits, instance.id, { limitMemoryMb: String(floor), limitCpuPercent: '' })).toMatchObject({ ok: true, message: 'Limits saved.' });
		expect(reload(instance.id).limitMemoryMb).toBe(floor);
	});

	it('count the heap a running server started with when it is bigger than the saved one', async () => {
		invalidateUnitState();
		fakeProcesses((cmd, args) => (args.includes('show') ? { stdout: 'ActiveState=active\nSubState=running\nMainPID=4242\n' } : {}));
		heap.runningMb = 8192;
		const instance = await server();
		expect(await post(actions.limits, instance.id, { limitMemoryMb: String(minMemoryLimitMb(4096)), limitCpuPercent: '' })).toMatchObject({
			status: 400,
			data: { message: expect.stringContaining('8192 MB heap (what the running server started with)') }
		});
		expect(await post(actions.limits, instance.id, { limitMemoryMb: String(minMemoryLimitMb(8192)), limitCpuPercent: '' })).toMatchObject({
			ok: true,
			message: 'Limits saved and applied to the running server.'
		});
	});

	it('keep the CPU between a tenth of one core and every core', async () => {
		systemdStopped();
		const instance = await server();
		const max = (cpus().length || 1) * 100;
		for (const cpu of ['5', '9', '12.5', String(max + 1), 'lots']) {
			expect(await post(actions.limits, instance.id, { limitMemoryMb: '', limitCpuPercent: cpu }), cpu).toMatchObject({
				status: 400,
				data: { message: `The CPU limit is between 10 and ${max} percent, or blank for none.` }
			});
		}
		expect(reload(instance.id).limitCpuPercent).toBeNull();
		expect(await post(actions.limits, instance.id, { limitMemoryMb: '', limitCpuPercent: String(max) })).toMatchObject({ ok: true });
		expect(await post(actions.limits, instance.id, { limitMemoryMb: '', limitCpuPercent: '' })).toMatchObject({ ok: true, message: 'Limits removed.' });
		expect(reload(instance.id)).toMatchObject({ limitMemoryMb: null, limitCpuPercent: null });
	});
});

describe('scheduled commands', () => {
	it('take a command, a time of day or one of the offered intervals', async () => {
		const instance = await server();
		const refusals: [Record<string, string>, string][] = [
			[{ command: '  ', mode: 'every', everyMinutes: '5' }, 'Enter the command to run.'],
			[{ command: '/', mode: 'every', everyMinutes: '5' }, 'Enter the command to run.'],
			[{ command: 'say ' + 'x'.repeat(500), mode: 'every', everyMinutes: '5' }, 'That command is too long.'],
			[{ command: 'save-all', mode: 'daily', dailyTime: '24:00' }, 'Pick a time of day.'],
			[{ command: 'save-all', mode: 'daily', dailyTime: '4:00' }, 'Pick a time of day.'],
			[{ command: 'save-all', mode: 'every', everyMinutes: '7' }, 'Pick how often it runs.'],
			[{ command: 'save-all', mode: 'every', everyMinutes: '0' }, 'Pick how often it runs.']
		];
		for (const [fields, message] of refusals) {
			expect(await post(actions.addCommand, instance.id, fields), JSON.stringify(fields)).toMatchObject({ status: 400, data: { message } });
		}
		expect(listScheduledCommands(instance.id)).toEqual([]);

		expect(await post(actions.addCommand, instance.id, { command: '/say hi\nthere', mode: 'daily', dailyTime: '04:30' })).toMatchObject({ ok: true });
		expect(await post(actions.addCommand, instance.id, { command: 'save-all', mode: 'every', everyMinutes: '60' })).toMatchObject({ ok: true });
		expect(listScheduledCommands(instance.id)).toEqual([
			expect.objectContaining({ command: 'say hi there', dailyTime: '04:30' }),
			expect.objectContaining({ command: 'save-all', everyMinutes: 60 })
		]);
	});
});
