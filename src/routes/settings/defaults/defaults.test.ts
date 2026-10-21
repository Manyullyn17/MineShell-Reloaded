import { afterEach, describe, expect, it } from 'vitest';
import { actions } from './+page.server';
import ConsoleFields from '#lib/components/ConsoleFields.svelte';
import RestartFields from '#lib/components/RestartFields.svelte';
import UpdateCheckFields from '#lib/components/UpdateCheckFields.svelte';
import { getInstanceDefaults, resetInstanceDefaults, setInstanceDefaults } from '#lib/server/instance-defaults.js';
import { formFields } from '../../../../tests/helpers/forms';
import { post } from '../../../../tests/helpers/routes';

afterEach(resetInstanceDefaults);

/** The new-server defaults (MineShell settings > New servers): one form, one action. */

/** Defaults with nothing at its built-in value, so a reset to one shows. */
function distinct() {
	const current = getInstanceDefaults();
	return setInstanceDefaults({
		...current,
		memoryMaxMb: 6144,
		memoryMinMb: 2048,
		restarts: { ...current.restarts, restartSchedule: 'none', restartSkipIfPlayers: true, restartWarnMinutes: 10, crashRestartLimit: 7, bootStart: 'always' },
		updates: { updateCheck: false, updateCheckHours: 6, updateChannel: 'beta', modUpdateCheck: true },
		console: { consoleBacklogLines: 500, consoleBufferLines: 4000 },
		limits: { memory: 'none', cpuPercent: 50 },
		properties: { ...current.properties, difficulty: 'hard', pvp: 'false' }
	});
}

/** The form's own fields (memory, preset, limits) as the page renders them for `d`. */
const ownFields = (d: ReturnType<typeof getInstanceDefaults>) => ({
	memoryMode: d.memoryMaxMb === null ? 'auto' : 'fixed',
	...(d.memoryMaxMb === null ? {} : { memoryMaxMb: String(d.memoryMaxMb) }),
	memoryMinMb: String(d.memoryMinMb),
	jvmPreset: d.jvmPreset,
	limitMemory: d.limits.memory,
	limitCpuMode: d.limits.cpuPercent === null ? 'none' : 'limit',
	limitCpuPercent: d.limits.cpuPercent === null ? '' : String(d.limits.cpuPercent)
});

describe('saving the new-server defaults', () => {
	it('refuses memory a server cannot start with and a preset that is gone, saving nothing', async () => {
		const before = distinct();
		const refusals: [Record<string, string>, string][] = [
			[{ memoryMode: 'fixed', memoryMaxMb: '400' }, 'Give a maximum memory of at least 512 MB, or pick automatic.'],
			[{ memoryMode: 'fixed', memoryMaxMb: 'lots' }, 'Give a maximum memory of at least 512 MB, or pick automatic.'],
			[{ memoryMinMb: '200' }, 'Starting memory needs to be at least 256 MB.'],
			[{ memoryMinMb: '' }, 'Starting memory needs to be at least 256 MB.'],
			[{ memoryMode: 'fixed', memoryMaxMb: '2048', memoryMinMb: '4096' }, 'Starting memory cannot exceed the maximum.'],
			[{ jvmPreset: 'gone-preset' }, 'That JVM preset no longer exists.']
		];
		for (const [fields, message] of refusals) {
			const result = await post(actions.save, { fields: { ...ownFields(before), ...fields, consoleBacklogLines: '1' } });
			expect(result, JSON.stringify(fields)).toMatchObject({ status: 400, data: { message } });
		}
		expect(getInstanceDefaults()).toEqual(before);
	});

	it('saved unchanged, keeps every value, whichever fields are hidden', async () => {
		const before = distinct();
		const fields = {
			...ownFields(before),
			...formFields(RestartFields, { values: before.restarts }),
			...formFields(UpdateCheckFields, { values: before.updates, mods: true }),
			...formFields(ConsoleFields, { values: before.console })
		};
		expect(await post(actions.save, { fields })).toMatchObject({ ok: true });
		expect(getInstanceDefaults()).toEqual(before);
	});
});
