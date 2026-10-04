import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	DEFAULTABLE_PROPERTIES,
	consoleFromForm,
	getInstanceDefaults,
	resetInstanceDefaults,
	restartsFromForm,
	setInstanceDefaults,
	suggestedMaxMb
} from '#lib/server/instance-defaults.js';
import { getPreset, listPresets } from '#lib/server/jvm-presets.js';
import { PROPERTY_GROUPS, propertiesFromForm } from '#lib/server/properties.js';
import { audit } from '#lib/server/instances.js';

export const load: PageServerLoad = async () => {
	return {
		defaults: getInstanceDefaults(),
		suggestedMaxMb: suggestedMaxMb(),
		presets: listPresets().map((p) => ({ id: p.id, name: p.name, description: p.description })),
		propertyGroups: PROPERTY_GROUPS.map((group) => ({
			group,
			fields: DEFAULTABLE_PROPERTIES.filter((f) => f.group === group)
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
		const jvmPreset = String(form.get('jvmPreset') ?? '');
		if (!getPreset(jvmPreset)) return fail(400, { ok: false, message: 'That JVM preset no longer exists.' });

		setInstanceDefaults({
			memoryMaxMb: fixed ? maxMb : null,
			memoryMinMb: minMb,
			jvmPreset,
			restarts: restartsFromForm(form, current.restarts),
			console: consoleFromForm(form, current.console),
			properties: { ...current.properties, ...propertiesFromForm(form, DEFAULTABLE_PROPERTIES) }
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
