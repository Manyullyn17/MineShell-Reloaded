import { afterEach, describe, expect, it } from 'vitest';
import { actions } from './+page.server';
import ConsoleFields from '#lib/components/ConsoleFields.svelte';
import RestartFields from '#lib/components/RestartFields.svelte';
import UpdateCheckFields from '#lib/components/UpdateCheckFields.svelte';
import { encryptSecret } from '#lib/server/crypto.js';
import { readProperties } from '#lib/server/properties.js';
import type { ServerInstance } from '#lib/server/db/schema.js';
import { createInstance, reload, systemdStopped } from '../../../../../tests/helpers/instances';
import { formFields } from '../../../../../tests/helpers/forms';
import { testPorts } from '../../../../../tests/helpers/ports';
import { resetProcesses } from '../../../../../tests/helpers/process';
import { post as postTo } from '../../../../../tests/helpers/routes';

afterEach(resetProcesses);

/**
 * A server's Settings posts each changed section's form to its own action
 * (CLAUDE.md, "UI layout"): an action must keep everything its form does not
 * carry, or saving one section resets another's settings.
 */

const post = (action: unknown, id: string, fields: Record<string, string | string[]>) => postTo(action, { params: { id }, fields });

/** A server with no setting at its default, so a reset to one shows. */
async function server(fields: Partial<ServerInstance> = {}) {
	const ports = testPorts();
	const instance = await createInstance(
		{
			modloader: 'fabric',
			minecraftVersion: '1.21.1',
			name: 'Before',
			...ports,
			rconPasswordEnc: encryptSecret('rcon-before'),
			memoryMaxMb: 2048,
			restartSchedule: 'interval',
			restartIntervalHours: 12,
			restartDailyTime: '03:30',
			restartWarnMinutes: 10,
			restartSkipIfPlayers: true,
			autoRestartOnCrash: false,
			crashRestartLimit: 7,
			crashRestartWindowSec: 1800,
			bootStart: 'always',
			limitMemoryMb: 8192,
			limitCpuPercent: 50,
			consoleBacklogLines: 500,
			consoleBufferLines: 4000,
			updateCheck: false,
			updateCheckHours: 6,
			updateChannel: 'beta',
			modUpdateCheck: false,
			...fields
		},
		{
			'server.properties': [
				'motd=Before',
				'difficulty=hard',
				'pvp=false',
				'white-list=true',
				'allow-flight=true',
				'max-players=7',
				'custom-key=kept',
				// As MineShell keeps them (syncPortsToProperties).
				`server-port=${ports.serverPort}`,
				`query.port=${ports.serverPort}`,
				'enable-rcon=true',
				`rcon.port=${ports.rconPort}`,
				'rcon.password=rcon-before'
			].join('\n')
		}
	);
	return instance;
}

/** Everything a section could touch: the row (but its timestamps) and server.properties. */
async function state(id: string) {
	const { updatedAt: _, ...row } = reload(id);
	return { row: row as Record<string, unknown>, properties: (await readProperties(reload(id).path)).values };
}

function without<T extends Record<string, unknown>>(record: T, keys: string[]): Partial<T> {
	return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key))) as Partial<T>;
}

type Section = {
	name: string;
	action: keyof typeof actions;
	/** What the section's form posts, with new values. */
	fields: (instance: ServerInstance) => Record<string, string>;
	/** Columns and server.properties keys it is meant to change. */
	columns: string[];
	properties?: string[];
	/** Changed as a consequence (the next scheduled restart, the next update check). */
	follows?: string[];
};

const SECTIONS: Section[] = [
	{ name: 'Identity', action: 'general', fields: () => ({ name: 'After' }), columns: ['name'] },
	{ name: 'a properties section (description)', action: 'properties', fields: () => ({ motd: 'After' }), columns: [], properties: ['motd'] },
	{
		name: 'a properties section with switches (players)',
		action: 'properties',
		fields: () => ({ 'max-players': '9', 'present:white-list': '1', 'present:pvp': '1', pvp: 'on' }),
		columns: [],
		properties: ['max-players', 'white-list', 'pvp']
	},
	{
		name: 'Port',
		action: 'network',
		fields: (i) => ({ serverPort: String(i.serverPort + 2), moveGame: '' }),
		columns: ['serverPort'],
		properties: ['server-port', 'query.port']
	},
	{
		name: 'RCON',
		action: 'network',
		fields: (i) => ({ rconPort: String(i.rconPort + 2), moveRcon: '' }),
		columns: ['rconPort'],
		properties: ['rcon.port']
	},
	{
		name: 'Resource limits',
		action: 'limits',
		fields: () => ({ limitMemoryMb: '6144', limitCpuPercent: '' }),
		columns: ['limitMemoryMb', 'limitCpuPercent']
	},
	{
		name: 'Update checks',
		action: 'updates',
		fields: () => ({ updateCheck: 'on', updateCheckHours: '24', updateChannel: 'release', modUpdateCheck: 'on' }),
		columns: ['updateCheck', 'updateCheckHours', 'updateChannel', 'modUpdateCheck'],
		follows: ['updateCheckedAt']
	},
	{
		name: 'Restarts',
		action: 'restarts',
		fields: () => ({
			bootStart: 'never',
			autoRestartOnCrash: 'on',
			crashRestartLimit: '3',
			crashRestartWindowSec: '600',
			restartSchedule: 'daily',
			restartDailyTime: '04:15',
			restartWarnMinutes: '5'
		}),
		columns: [
			'bootStart',
			'autoRestartOnCrash',
			'crashRestartLimit',
			'crashRestartWindowSec',
			'restartSchedule',
			'restartDailyTime',
			'restartWarnMinutes',
			'restartSkipIfPlayers'
		],
		follows: ['restartNextAt']
	},
	{
		name: 'Console',
		action: 'console',
		fields: () => ({ consoleBacklogLines: '200', consoleBufferLines: '1000' }),
		columns: ['consoleBacklogLines', 'consoleBufferLines']
	},
	{
		name: 'Scheduled snapshots',
		action: 'snapshotSchedule',
		fields: () => ({
			snapshotEvery: 'daily',
			snapshotDailyTime: '02:00',
			snapshotIntervalHours: '6',
			snapshotWhileRunning: 'live',
			snapshotWarnMinutes: '5'
		}),
		columns: []
	}
];

describe('a Settings section saves only its own fields', () => {
	it.each(SECTIONS)('$name', async (section) => {
		systemdStopped();
		const instance = await server();
		const before = await state(instance.id);

		expect(await post(actions[section.action], instance.id, section.fields(instance))).toMatchObject({ ok: true });

		const after = await state(instance.id);
		const columns = [...section.columns, ...(section.follows ?? [])];
		expect(without(after.row, columns)).toEqual(without(before.row, columns));
		expect(without(after.properties, section.properties ?? [])).toEqual(without(before.properties, section.properties ?? []));
		// And the post did reach it.
		for (const column of section.columns) expect(after.row[column], column).not.toEqual(before.row[column]);
		for (const key of section.properties ?? []) expect(after.properties[key], key).not.toEqual(before.properties[key]);
	});
});

/**
 * The shared field components (also on the new-server defaults page), rendered
 * from saved values and posted as a browser would: saving a section nobody
 * changed changes nothing, whichever fields are hidden or disabled.
 */
describe('a section saved unchanged keeps every value', () => {
	async function unchanged(instance: ServerInstance, action: keyof typeof actions, fields: Record<string, string[]>, follows: string[] = []) {
		const before = await state(instance.id);
		expect(await post(actions[action], instance.id, fields)).toMatchObject({ ok: true });
		expect(without((await state(instance.id)).row, follows)).toEqual(without(before.row, follows));
	}

	// Scheduled "none" hides the skip-if-players switch: saving used to turn it off.
	it.each(['none', 'interval', 'daily'])('restarts, scheduled %s', async (restartSchedule) => {
		systemdStopped();
		const instance = await server({ restartSchedule });
		await unchanged(instance, 'restarts', formFields(RestartFields, { values: instance }), ['restartNextAt']);
	});

	it.each([
		{ updateCheck: true, mods: true },
		{ updateCheck: true, mods: false },
		{ updateCheck: false, mods: true },
		{ updateCheck: false, mods: false }
	])('update checks %o', async ({ updateCheck, mods }) => {
		const instance = await server({ updateCheck, modUpdateCheck: true });
		const fields = formFields(UpdateCheckFields, { values: instance, loader: 'fabric', mods });
		await unchanged(instance, 'updates', fields, ['updateCheckedAt']);
	});

	it('console', async () => {
		const instance = await server();
		await unchanged(instance, 'console', formFields(ConsoleFields, { values: instance }));
	});
});

// A server's name had no limit when made or renamed (only a copy's was cut, at 80): a
// pasted paragraph became the name every page and the systemd description carried.
describe('a server name', () => {
	it('is cut to 80 characters and one line on rename', async () => {
		const instance = await server();
		expect(await post(actions.general, instance.id, { name: `  ${'Long name '.repeat(30)}\nsecond line` })).toMatchObject({ ok: true });
		const { name } = reload(instance.id);
		expect(name).toHaveLength(79);
		expect(name).toBe('Long name '.repeat(8).trim());
	});
});
