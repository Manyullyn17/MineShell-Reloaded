import { afterEach, describe, expect, it } from 'vitest';
import * as page from './+page.server';
import { createInstance, systemdStopped } from '../../../../tests/helpers/instances';
import { resetProcesses } from '../../../../tests/helpers/process';
import { load } from '../../../../tests/helpers/routes';

afterEach(resetProcesses);

/** The overview: the chart's range comes from the address. */

const server = (fields = {}) => createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', ...fields }, { 'eula.txt': 'eula=true' });

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
