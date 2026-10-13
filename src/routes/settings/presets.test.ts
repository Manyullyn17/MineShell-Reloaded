import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actions } from './+page.server';
import { actions as serverActions } from '../instances/[id]/settings/+page.server';
import { deleteCustomPreset, listPresets } from '#lib/server/jvm-presets.js';
import { addJava, clearJava } from '../../../tests/helpers/instances';
import { fakeProcesses, resetProcesses } from '../../../tests/helpers/process';

beforeEach(clearJava);
afterEach(() => {
	clearJava();
	resetProcesses();
});

async function post(action: unknown, fields: Record<string, string>) {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return await (action as (event: never) => unknown)({ request: new Request('http://localhost/', { method: 'POST', body: form }) } as never);
}

describe('JVM flag presets', () => {
	it('are saved and deleted in MineShell settings, not by a server page, since every server shares them', async () => {
		expect(Object.keys(serverActions)).not.toContain('savePreset');
		expect(Object.keys(serverActions)).not.toContain('deletePreset');

		expect(await post(actions.savePreset, { presetName: 'Route test', jvmArgs: '-Xmx4G -XX:+UseG1GC' })).toMatchObject({ ok: true });
		const saved = listPresets().find((p) => p.name === 'Route test');
		expect(saved).toMatchObject({ builtIn: false, flags: '-XX:+UseG1GC' });

		await post(actions.deletePreset, { presetId: saved!.id });
		expect(listPresets().some((p) => p.name === 'Route test')).toBe(false);
	});

	it('are saved with a note naming the installed Java versions that would not start with them', async () => {
		addJava(8);
		addJava(21);
		fakeProcesses((cmd, args) =>
			cmd.includes('java-8') && args.includes('-XX:+UseZGC')
				? { code: 1, stderr: "Unrecognized VM option 'UseZGC'\nError: Could not create the Java Virtual Machine.\nError: A fatal exception has occurred. Program will exit.\n" }
				: {}
		);
		const result = await post(actions.savePreset, { presetName: 'Low pause', jvmArgs: '-XX:+UseZGC' });
		expect(result).toMatchObject({ ok: true });
		expect((result as { message: string }).message).toContain("Java 8 does not start with it: Unrecognized VM option 'UseZGC'");
		expect((result as { message: string }).message).not.toContain('Java 21');
		deleteCustomPreset(listPresets().find((p) => p.name === 'Low pause')!.id);
	});

	it('need a name', async () => {
		expect(await post(actions.savePreset, { presetName: ' ', jvmArgs: '-XX:+UseG1GC' })).toMatchObject({ status: 400 });
	});
});
