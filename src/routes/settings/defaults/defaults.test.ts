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
import { fetchCalls, useRecordedHttp } from '../../../../tests/helpers/http';

const NOTCH = { name: 'Notch', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5' };
const JEB = { name: 'jeb_', uuid: '853c80ef-3c37-49fd-aa49-938b674adae6' };
const PROFILE = 'https://api.mojang.com/users/profiles/minecraft/';
// Mojang's answers as its profile endpoint gives them: the name as the account spells it.
useRecordedHttp('none', {
	extra: {
		[`${PROFILE}jeb_`]: () => Response.json({ id: JEB.uuid.replace(/-/g, ''), name: 'jeb_' }),
		[`${PROFILE}JEB_`]: () => Response.json({ id: JEB.uuid.replace(/-/g, ''), name: 'jeb_' }),
		[`${PROFILE}NoSuchPlayer1`]: () => new Response(null, { status: 404 })
	}
});

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
		properties: { ...current.properties, difficulty: 'hard', pvp: 'false' },
		players: { whitelist: [NOTCH], ops: [NOTCH] }
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
	limitCpuPercent: d.limits.cpuPercent === null ? '' : String(d.limits.cpuPercent),
	whitelistNames: d.players.whitelist.map((p) => p.name).join('\n'),
	opNames: d.players.ops.map((p) => p.name).join('\n')
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

	it('looks up new players with Mojang and keeps the UUID of those already saved', async () => {
		const before = distinct();
		fetchCalls.length = 0;
		const fields = { ...ownFields(before), whitelistNames: 'notch\nJEB_\n', opNames: 'Notch jeb_' };
		expect(await post(actions.save, { fields })).toMatchObject({ ok: true });
		expect(getInstanceDefaults().players).toEqual({ whitelist: [NOTCH, JEB], ops: [NOTCH, JEB] });
		// Notch was saved already: only jeb_ was asked about.
		expect(fetchCalls.map((c) => c.url)).toEqual([`${PROFILE}JEB_`]);
	});

	it('refuses a name Mojang does not know or that is no Java name, saving nothing', async () => {
		const before = distinct();
		for (const [fields, message] of [
			[{ whitelistNames: 'Notch\nNoSuchPlayer1' }, 'Whitelist: Mojang knows no account called NoSuchPlayer1, or could not be asked. Check the spelling, or try again later.'],
			[{ opNames: 'not-a-name' }, 'Operators: Not a Java player name: not-a-name.']
		] as const) {
			const result = await post(actions.save, { fields: { ...ownFields(before), ...fields } });
			expect(result).toMatchObject({ status: 400, data: { message } });
		}
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
