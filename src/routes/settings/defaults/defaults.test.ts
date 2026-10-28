import { afterEach, describe, expect, it } from 'vitest';
import { actions } from './+page.server';
import ConsoleFields from '#lib/components/ConsoleFields.svelte';
import RestartFields from '#lib/components/RestartFields.svelte';
import UpdateCheckFields from '#lib/components/UpdateCheckFields.svelte';
import SnapshotScheduleFields from '#lib/components/SnapshotScheduleFields.svelte';
import { getInstanceDefaults, resetInstanceDefaults, setInstanceDefaults } from '#lib/server/instance-defaults.js';
import { NEW_SERVER_SCHEDULE, type SnapshotSchedule } from '#lib/shared/snapshotschedule.js';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';
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
		snapshots: { every: 'interval', dailyTime: '03:15', intervalHours: 12, whileRunning: 'stop', warnMinutes: 10, skipIdle: false },
		properties: { ...current.properties, difficulty: 'hard', pvp: 'false' }
	});
}

/** A schedule as SnapshotScheduleFields holds it. */
const scheduleValues = (s: SnapshotSchedule) => ({
	snapshotEvery: s.every,
	snapshotDailyTime: s.dailyTime,
	snapshotIntervalHours: s.intervalHours,
	snapshotWhileRunning: s.whileRunning,
	snapshotWarnMinutes: s.warnMinutes,
	snapshotSkipIdle: s.skipIdle
});

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
			[{ jvmPreset: 'gone-preset' }, 'That JVM preset no longer exists.'],
			[{ snapshotEvery: 'daily', snapshotDailyTime: '25:00' }, 'Give the snapshot time as HH:MM.']
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
			...formFields(ConsoleFields, { values: before.console }),
			...formFields(SnapshotScheduleFields, { values: scheduleValues(before.snapshots) })
		};
		expect(await post(actions.save, { fields })).toMatchObject({ ok: true });
		expect(getInstanceDefaults()).toEqual(before);
	});

	// Saved before the defaults had a schedule: new servers then still get the built-in one.
	it('gives defaults stored without a snapshot schedule the built-in daily one', () => {
		const stored = { ...getInstanceDefaults() } as Partial<ReturnType<typeof getInstanceDefaults>>;
		delete stored.snapshots;
		const value = JSON.stringify(stored);
		db.insert(settings).values({ key: 'instance.defaults', value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
		expect(getInstanceDefaults().snapshots).toEqual(NEW_SERVER_SCHEDULE);
		expect(NEW_SERVER_SCHEDULE).toMatchObject({ every: 'daily', dailyTime: '04:00', whileRunning: 'live', skipIdle: true });
	});
});
