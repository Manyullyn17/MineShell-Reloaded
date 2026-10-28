import { afterEach, describe, expect, it } from 'vitest';
import * as page from './+page.server';
import { actions } from './+page.server';
import { cancelCountdown, getCountdown } from '#lib/server/countdown.js';
import { invalidateUnitState } from '#lib/server/systemd.js';
import { readProperties } from '#lib/server/properties.js';
import { createInstance, systemdStopped } from '../../../../tests/helpers/instances';
import { fakeProcesses, resetProcesses, spawnCalls } from '../../../../tests/helpers/process';
import { load, post as postTo } from '../../../../tests/helpers/routes';

afterEach(resetProcesses);

/** The overview: the header's power buttons post here, and the chart's range comes from the address. */

const post = (action: unknown, id: string, fields: Record<string, string>) => postTo(action, { params: { id }, fields });
const acted = (verb: string) => spawnCalls.filter((c) => c.cmd === 'systemctl' && c.args.includes(verb));

function running() {
	invalidateUnitState();
	fakeProcesses((cmd, args) => (args.includes('show') ? { stdout: 'ActiveState=active\nSubState=running\nResult=success\n' } : {}));
}

const server = (fields = {}) => createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', ...fields }, { 'eula.txt': 'eula=true' });

describe('the power buttons', () => {
	it('stop after a countdown when given a delay, and stopping by hand replaces the countdown', async () => {
		running();
		const instance = await server();
		expect(await post(actions.power, instance.id, { verb: 'stop', delay: '300' })).toMatchObject({ ok: true, message: expect.stringMatching(/^Stopping in 5 minutes/) });
		expect(getCountdown(instance.id)).toMatchObject({ verb: 'stop' });
		expect(acted('stop')).toEqual([]);

		await post(actions.power, instance.id, { verb: 'stop' });
		expect(getCountdown(instance.id)).toBeNull();
		expect(acted('stop').length).toBeGreaterThan(0);
	});

	it('take the delay from the address when the form has none (the header menu)', async () => {
		running();
		const instance = await server();
		expect(await postTo(actions.power, { params: { id: instance.id }, fields: { verb: 'restart' }, url: 'http://localhost/?delay=60' })).toMatchObject({ ok: true });
		expect(getCountdown(instance.id)).toMatchObject({ verb: 'restart' });
		cancelCountdown(instance.id);
	});

	it('refuse a delay out of range instead of acting at once', async () => {
		running();
		const instance = await server();
		for (const delay of ['7200', '-5', '1.5', 'soon']) {
			expect(await post(actions.power, instance.id, { verb: 'stop', delay })).toMatchObject({ status: 400, data: { message: expect.stringMatching(/up to an hour/) } });
		}
		expect(getCountdown(instance.id)).toBeNull();
		expect(acted('stop')).toEqual([]);
	});

	it('refuse a verb they do not know, doing nothing', async () => {
		systemdStopped();
		const instance = await server();
		expect(await post(actions.power, instance.id, { verb: 'dance' })).toMatchObject({ status: 400, data: { message: 'Unknown action "dance".' } });
		expect(spawnCalls.filter((c) => !c.args.includes('show'))).toEqual([]);
	});

	it('warn before starting a server that does not fit in memory, and start it when asked again', async () => {
		systemdStopped();
		// A heap no machine has.
		const instance = await server({ memoryMaxMb: 64 * 1024 * 1024, memoryMinMb: 1024 });
		expect(await post(actions.power, instance.id, { verb: 'start' })).toMatchObject({ status: 409, data: { memoryWarning: true } });
		expect(acted('start')).toEqual([]);

		const forced = await post(actions.power, instance.id, { verb: 'start', force: 'on' });
		expect(forced).not.toMatchObject({ data: { memoryWarning: true } });
	});
});

describe("the watchdog diagnosis' button", () => {
	it('raises max-tick-time to an offered step only, and only while the server is stopped', async () => {
		systemdStopped();
		const instance = await server();
		for (const ms of ['-1', '0', '999999', '60000', 'lots', '']) {
			expect(await post(actions.tickLimit, instance.id, { ms }), ms).toMatchObject({ status: 400, data: { message: 'Not a tick limit MineShell offers.' } });
		}
		expect((await readProperties(instance.path)).values['max-tick-time']).toBeUndefined();
		expect(await post(actions.tickLimit, instance.id, { ms: '180000' })).toMatchObject({ ok: true, message: expect.stringMatching(/up to 3 minutes/) });
		expect((await readProperties(instance.path)).values).toMatchObject({ 'max-tick-time': '180000' });

		running();
		expect(await post(actions.tickLimit, instance.id, { ms: '600000' })).toMatchObject({ status: 400, data: { message: 'Stop the server first.' } });
		expect((await readProperties(instance.path)).values['max-tick-time']).toBe('180000');
	});
});

describe("the overview's chart range", () => {
	it('is one of its windows, else the last hour', async () => {
		systemdStopped();
		const instance = await server();
		const rangeOf = async (range: string) =>
			(await load(page, { params: { id: instance.id }, url: `http://localhost/instances/${instance.id}?range=${range}` })).rangeMs;
		expect(await rangeOf('6h')).toBe(6 * 60 * 60 * 1000);
		for (const range of ['7d', 'toString', 'constructor', '']) expect(await rangeOf(range), range).toBe(60 * 60 * 1000);
	});
});
