import { describe, expect, it } from 'vitest';
import { actions } from './+page.server';
import { actions as serverActions } from '../instances/[id]/settings/+page.server';
import { listPresets } from '#lib/server/jvm-presets.js';

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

	it('need a name', async () => {
		expect(await post(actions.savePreset, { presetName: ' ', jvmArgs: '-XX:+UseG1GC' })).toMatchObject({ status: 400 });
	});
});
