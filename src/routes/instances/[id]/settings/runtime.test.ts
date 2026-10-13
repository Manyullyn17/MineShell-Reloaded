import { afterEach, describe, expect, it } from 'vitest';
import { actions } from './+page.server';
import { getInstance } from '#lib/server/instances.js';
import { createInstance } from '../../../../../tests/helpers/instances';
import { fakeProcesses, resetProcesses } from '../../../../../tests/helpers/process';

afterEach(resetProcesses);

async function post(action: unknown, id: string, fields: Record<string, string>) {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	const request = new Request('http://localhost/', { method: 'POST', body: form });
	return await (action as (event: never) => unknown)({ params: { id }, request } as never);
}

describe('memory and launch settings', () => {
	it('are saved by separate actions: memory never changes what the server runs', async () => {
		fakeProcesses(() => ({}));
		const instance = await createInstance({
			modloader: 'vanilla',
			minecraftVersion: '1.21.1',
			memoryMinMb: 1024,
			memoryMaxMb: 2048,
			jvmArgs: '-Xms1024M -Xmx2048M -XX:+UseG1GC',
			launchArgs: '-jar server.jar nogui',
			javaPath: null
		});

		const saved = await post(actions.memory, instance.id, {
			memoryMinMb: '2048',
			memoryMaxMb: '6144',
			javaPathManual: '/bin/sh',
			jvmArgs: '-XX:+Evil',
			launchArgs: '-c true'
		});
		expect(saved).toMatchObject({ ok: true });
		expect(getInstance(instance.id)).toMatchObject({
			memoryMinMb: 2048,
			memoryMaxMb: 6144,
			jvmArgs: '-Xms2048M -Xmx6144M -XX:+UseG1GC',
			launchArgs: '-jar server.jar nogui',
			javaPath: null
		});
		expect(Object.keys(actions)).not.toContain('runtime');
	});

	it('launch keeps the saved memory in the rebuilt JVM arguments', async () => {
		fakeProcesses(() => ({}));
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', memoryMinMb: 1024, memoryMaxMb: 4096 });
		await post(actions.launch, instance.id, { jvmArgs: '-Xmx99G -XX:+UseZGC', launchArgs: '-jar other.jar nogui', javaPath: '' });
		expect(getInstance(instance.id)).toMatchObject({
			jvmArgs: '-Xms1024M -Xmx4096M -XX:+UseZGC',
			launchArgs: '-jar other.jar nogui',
			memoryMaxMb: 4096
		});
	});

	it('memory refuses a starting size above the maximum', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		expect(await post(actions.memory, instance.id, { memoryMinMb: '8192', memoryMaxMb: '4096' })).toMatchObject({ status: 400 });
	});
});
