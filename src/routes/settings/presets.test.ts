import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actions } from './+page.server';
import { actions as serverActions } from '../instances/[id]/settings/+page.server';
import { deleteCustomPreset, listPresets } from '#lib/server/jvm-presets.js';
import { getInstanceDefaults, resetInstanceDefaults, setInstanceDefaults } from '#lib/server/instance-defaults.js';
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

	it('are edited in place: renaming keeps the id the defaults for new servers refer to', async () => {
		expect(await post(actions.savePreset, { presetName: 'Before', presetDescription: ' For big packs ', jvmArgs: '-XX:+UseG1GC' })).toMatchObject({ ok: true });
		const saved = listPresets().find((p) => p.name === 'Before')!;
		expect(saved).toMatchObject({ id: 'custom:before', description: 'For big packs' });

		expect(await post(actions.updatePreset, { presetId: saved.id, presetName: 'After', presetDescription: '', jvmArgs: '-Xmx8G -XX:+UseZGC' })).toMatchObject({ ok: true });
		expect(listPresets().find((p) => p.id === saved.id)).toMatchObject({ name: 'After', description: '', flags: '-XX:+UseZGC' });

		// The old name maps to the same id again: the new preset gets another one.
		await post(actions.savePreset, { presetName: 'Before', jvmArgs: '-XX:+UseG1GC' });
		const again = listPresets().find((p) => p.name === 'Before')!;
		expect(again.id).toBe('custom:before-2');
		// Saving under an existing name replaces that preset, id and all.
		await post(actions.savePreset, { presetName: 'after', jvmArgs: '-XX:+UseParallelGC' });
		expect(listPresets().filter((p) => p.id === saved.id)).toMatchObject([{ name: 'after', flags: '-XX:+UseParallelGC' }]);

		// An edit cannot take another preset's name, nor a built-in's.
		expect(await post(actions.updatePreset, { presetId: saved.id, presetName: 'BEFORE', presetDescription: '', jvmArgs: '' })).toMatchObject({ status: 400 });
		expect(await post(actions.updatePreset, { presetId: saved.id, presetName: 'Minimal', presetDescription: '', jvmArgs: '' })).toMatchObject({ status: 400 });
		expect(await post(actions.updatePreset, { presetId: 'custom:gone', presetName: 'X', presetDescription: '', jvmArgs: '' })).toMatchObject({ status: 400 });

		deleteCustomPreset(saved.id);
		deleteCustomPreset(again.id);
	});

	it('say so when the one new servers get is deleted, and make the built-in default theirs', async () => {
		await post(actions.savePreset, { presetName: 'House', jvmArgs: '-XX:+UseG1GC' });
		await post(actions.savePreset, { presetName: 'Other', jvmArgs: '-XX:+UseG1GC' });
		setInstanceDefaults({ ...getInstanceDefaults(), jvmPreset: 'custom:house' });

		const other = await post(actions.deletePreset, { presetId: 'custom:other' });
		expect((other as { message: string }).message).not.toContain('New servers');
		expect(getInstanceDefaults().jvmPreset).toBe('custom:house');

		const house = await post(actions.deletePreset, { presetId: 'custom:house' });
		expect((house as { message: string }).message).toContain('New servers got it; they get Aikar (recommended) now');
		expect(getInstanceDefaults().jvmPreset).toBe('aikar');
		resetInstanceDefaults();
	});

	it('need a name', async () => {
		expect(await post(actions.savePreset, { presetName: ' ', jvmArgs: '-XX:+UseG1GC' })).toMatchObject({ status: 400 });
		// The id comes from the name: "!!!" and "???" would be one preset.
		expect(await post(actions.savePreset, { presetName: '!!!', jvmArgs: '-XX:+UseG1GC' })).toMatchObject({ status: 400 });
	});

	it('cannot take a built-in preset’s name, which would show twice in the picker', async () => {
		expect(await post(actions.savePreset, { presetName: 'aikar (Recommended)', jvmArgs: '-XX:+UseG1GC' })).toMatchObject({ status: 400 });
		expect(listPresets().filter((p) => p.name.toLowerCase() === 'aikar (recommended)')).toHaveLength(1);
	});
});
