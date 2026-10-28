import { afterEach, describe, expect, it } from 'vitest';
import { actions } from './+page.server';
import { getInstance } from '#lib/server/instances.js';
import { addJava, clearJava, createInstance } from '../../../../../tests/helpers/instances';
import { fakeProcesses, resetProcesses, spawnCalls } from '../../../../../tests/helpers/process';
import { post as postTo } from '../../../../../tests/helpers/routes';

afterEach(resetProcesses);

const post = (action: unknown, id: string, fields: Record<string, string>) => postTo(action, { params: { id }, fields });

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

	it('applies a preset with the flags for the server’s Java, and refuses one it cannot start with', async () => {
		fakeProcesses(() => ({}));
		clearJava();
		const java21 = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', memoryMinMb: 1024, memoryMaxMb: 4096, javaPath: addJava(21) });
		expect(await post(actions.launch, java21.id, { applyPreset: 'zgc', launchArgs: '-jar server.jar nogui' })).toMatchObject({ ok: true });
		expect(getInstance(java21.id)!.jvmArgs).toBe('-Xms1024M -Xmx4096M -XX:+UseZGC -XX:+AlwaysPreTouch -XX:+DisableExplicitGC -XX:+PerfDisableSharedMem -XX:+ZGenerational');

		const java17 = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.20.1', javaPath: addJava(17) });
		await post(actions.launch, java17.id, { applyPreset: 'zgc', launchArgs: '-jar server.jar nogui' });
		expect(getInstance(java17.id)!.jvmArgs).not.toContain('ZGenerational');

		const java8 = await createInstance({ modloader: 'forge', minecraftVersion: '1.12.2', jvmArgs: '-Xms1024M -Xmx2048M -XX:+UseG1GC', javaPath: addJava(8) });
		expect(await post(actions.launch, java8.id, { applyPreset: 'zgc', launchArgs: '-jar server.jar nogui' })).toMatchObject({ status: 400 });
		expect(getInstance(java8.id)!.jvmArgs).toBe('-Xms1024M -Xmx2048M -XX:+UseG1GC');
		clearJava();
	});

	it('launch refuses flags the server’s Java does not start with, in Java’s words', async () => {
		clearJava();
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.20.1', memoryMinMb: 1024, memoryMaxMb: 2048, jvmArgs: '-Xms1024M -Xmx2048M -XX:+UseG1GC', javaPath: addJava(17) });
		fakeProcesses((cmd, args) =>
			cmd.endsWith('/java') && args.includes('-XX:+ZGenerational')
				? { code: 1, stderr: "Unrecognized VM option 'ZGenerational'\nError: Could not create the Java Virtual Machine.\nError: A fatal exception has occurred. Program will exit.\n" }
				: cmd.endsWith('/java')
					? { stderr: 'OpenJDK 64-Bit Server VM warning: Ignoring option Foo; support was removed in 24.0\nopenjdk version "17.0.1"\n' }
					: {}
		);
		const refused = await post(actions.launch, instance.id, { jvmArgs: '-XX:+UseZGC -XX:+ZGenerational', launchArgs: '-jar server.jar nogui' });
		expect(refused).toMatchObject({ status: 400, data: { message: "Java 17 does not start with these flags: Unrecognized VM option 'ZGenerational'" } });
		expect(getInstance(instance.id)!.jvmArgs).toBe('-Xms1024M -Xmx2048M -XX:+UseG1GC');

		// Checked with the maximum heap, without the starting size and pre-touch.
		const saved = await post(actions.launch, instance.id, { jvmArgs: '-XX:+AlwaysPreTouch -XX:+UseZGC', launchArgs: '-jar server.jar nogui' });
		expect(saved).toMatchObject({ ok: true });
		expect((saved as { message: string }).message).toContain('Java warns: Ignoring option Foo; support was removed in 24.0');
		const check = spawnCalls.filter((c) => c.cmd.endsWith('/java')).at(-1)!;
		expect(check.args).toEqual(['-Xmx2048M', '-XX:+UseZGC', '-version']);
		clearJava();
	});

	it('launch refuses quotes in changed arguments, and still saves the rest when old ones have them', async () => {
		fakeProcesses(() => ({}));
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', memoryMinMb: 1024, memoryMaxMb: 2048, jvmArgs: '-Xms1024M -Xmx2048M', launchArgs: '-jar server.jar nogui' });
		const refused = await post(actions.launch, instance.id, { jvmArgs: '-Dlog4j.configurationFile="log4j2.xml"', launchArgs: '-jar server.jar nogui' });
		expect(refused).toMatchObject({ status: 400, data: { message: expect.stringContaining('Leave the quotes out') } });
		expect(await post(actions.launch, instance.id, { jvmArgs: '', launchArgs: "-jar 'server.jar' nogui" })).toMatchObject({ status: 400 });
		expect(getInstance(instance.id)).toMatchObject({ jvmArgs: '-Xms1024M -Xmx2048M', launchArgs: '-jar server.jar nogui' });

		// Saved before the check: a new Java path still saves with them as they are.
		const old = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', memoryMinMb: 1024, memoryMaxMb: 2048, jvmArgs: '-Xms1024M -Xmx2048M -Dx="y"', launchArgs: '-jar server.jar nogui' });
		expect(await post(actions.launch, old.id, { jvmArgs: '-Dx="y"', launchArgs: '-jar server.jar nogui', javaPathManual: '/bin/sh' })).toMatchObject({ ok: true });
		expect(getInstance(old.id)!.javaPath).toBe('/bin/sh');
	});

	it('memory refuses a starting size above the maximum', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		expect(await post(actions.memory, instance.id, { memoryMinMb: '8192', memoryMaxMb: '4096' })).toMatchObject({ status: 400 });
	});
});
