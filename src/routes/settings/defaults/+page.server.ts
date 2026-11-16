import { cpus } from 'node:os';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { bootStartNote } from '#lib/server/bootstart.js';
import {
	DEFAULTABLE_PROPERTIES,
	consoleFromForm,
	getInstanceDefaults,
	limitsFromForm,
	resetInstanceDefaults,
	restartsFromForm,
	setInstanceDefaults,
	suggestedMaxMb,
	updatesFromForm
} from '#lib/server/instance-defaults.js';
import { getPreset, listPresets } from '#lib/server/jvm-presets.js';
import { PROPERTY_GROUPS, propertiesFromForm, withVersionNote } from '#lib/server/properties.js';
import { audit } from '#lib/server/instances.js';
import { scheduleFromForm } from '#lib/shared/snapshotschedule.js';
import { totalMemoryMb } from '#lib/server/servercap.js';
import { JAVA_NAME, MAX_DEFAULT_PLAYERS, namesFromText, type DefaultPlayer } from '#lib/server/defaultplayers.js';
import { resolveProfile } from '#lib/server/players.js';

/**
 * The names typed for a list as Mojang accounts: a name already saved keeps its UUID, a new
 * one is looked up. What cannot be is named back, so nothing is saved half done.
 */
async function playersFromText(text: string, saved: DefaultPlayer[]): Promise<{ players: DefaultPlayer[] } | { problem: string }> {
	const names = namesFromText(text);
	if (names.length > MAX_DEFAULT_PLAYERS) return { problem: `At most ${MAX_DEFAULT_PLAYERS} players a list.` };
	const invalid = names.filter((n) => !JAVA_NAME.test(n));
	if (invalid.length) return { problem: `Not a Java player name: ${invalid.join(', ')}.` };
	const players: DefaultPlayer[] = [];
	const unknown: string[] = [];
	for (const name of names) {
		const known = saved.find((p) => p.name.toLowerCase() === name.toLowerCase());
		const profile = known ?? (await resolveProfile(name));
		if (!profile) unknown.push(name);
		else if (!players.some((p) => p.uuid === profile.uuid)) players.push({ name: profile.name, uuid: profile.uuid });
	}
	if (unknown.length) {
		return { problem: `Mojang knows no account called ${unknown.join(', ')}, or could not be asked. Check the spelling, or try again later.` };
	}
	return { players };
}

export const load: PageServerLoad = async () => {
	return {
		defaults: getInstanceDefaults(),
		suggestedMaxMb: suggestedMaxMb(),
		machineMemoryMb: totalMemoryMb(),
		cpuCores: cpus().length || 1,
		bootNote: bootStartNote(),
		presets: listPresets().map((p) => ({ id: p.id, name: p.name, description: p.description, minJava: p.minJava ?? null })),
		propertyGroups: PROPERTY_GROUPS.map((group) => ({
			group,
			fields: DEFAULTABLE_PROPERTIES.filter((f) => f.group === group).map(withVersionNote)
		})).filter((g) => g.fields.length > 0)
	};
};

export const actions: Actions = {
	save: async ({ request }) => {
		const form = await request.formData();
		const current = getInstanceDefaults();

		const fixed = form.get('memoryMode') === 'fixed';
		const maxMb = Number(form.get('memoryMaxMb'));
		const minMb = Number(form.get('memoryMinMb'));
		if (fixed && !(Number.isFinite(maxMb) && maxMb >= 512)) {
			return fail(400, { ok: false, message: 'Give a maximum memory of at least 512 MB, or pick automatic.' });
		}
		if (!(Number.isFinite(minMb) && minMb >= 256)) {
			return fail(400, { ok: false, message: 'Starting memory needs to be at least 256 MB.' });
		}
		if (fixed && minMb > maxMb) {
			return fail(400, { ok: false, message: 'Starting memory cannot exceed the maximum.' });
		}
		if (form.get('snapshotEvery') === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(form.get('snapshotDailyTime') ?? ''))) {
			return fail(400, { ok: false, message: 'Give the snapshot time as HH:MM.' });
		}
		const jvmPreset = String(form.get('jvmPreset') ?? '');
		if (!getPreset(jvmPreset)) return fail(400, { ok: false, message: 'That JVM preset no longer exists.' });
		const whitelist = await playersFromText(String(form.get('whitelistNames') ?? ''), current.players.whitelist);
		if ('problem' in whitelist) return fail(400, { ok: false, message: `Whitelist: ${whitelist.problem}` });
		const ops = await playersFromText(String(form.get('opNames') ?? ''), current.players.ops);
		if ('problem' in ops) return fail(400, { ok: false, message: `Operators: ${ops.problem}` });

		setInstanceDefaults({
			memoryMaxMb: fixed ? maxMb : null,
			memoryMinMb: minMb,
			jvmPreset,
			restarts: restartsFromForm(form, current.restarts),
			console: consoleFromForm(form, current.console),
			limits: limitsFromForm(form, current.limits),
			updates: updatesFromForm(form, current.updates),
			snapshots: scheduleFromForm(form),
			properties: { ...current.properties, ...propertiesFromForm(form, DEFAULTABLE_PROPERTIES) },
			players: { whitelist: whitelist.players, ops: ops.players }
		});
		audit('settings.instance_defaults');
		return { ok: true, message: 'Saved. New servers start with these; existing ones keep their own settings.' };
	},

	reset: async () => {
		resetInstanceDefaults();
		audit('settings.instance_defaults', { detail: 'reset' });
		return { ok: true, message: 'Back to the built-in defaults.' };
	}
};
