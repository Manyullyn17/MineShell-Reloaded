import { fail } from '@sveltejs/kit';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Actions, PageServerLoad } from './$types';
import { requireInstance, summarise, syncPortsToProperties } from '$lib/server/instances';
import {
	PROPERTY_GROUPS,
	PROPERTY_SCHEMA,
	readProperties,
	writeProperties,
	parseProperties,
	serialiseProperties,
	levelTypeOptionsFor,
	propertiesFromForm
} from '$lib/server/properties';
import { db } from '$lib/server/db';
import { serverInstances } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { portConflict } from '$lib/server/ports';

/** Keys MineShell owns; editing them here would desynchronise the DB. */
const MANAGED_KEYS = new Set(['rcon.password', 'enable-rcon', 'rcon.port']);

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	const parsed = await readProperties(instance.path);
	const summary = await summarise(instance);

	return {
		values: parsed.values,
		extras: parsed.extraKeys
			.filter((k) => !MANAGED_KEYS.has(k))
			.map((key) => ({ key, value: parsed.values[key] })),
		schema: PROPERTY_SCHEMA.filter((f) => !MANAGED_KEYS.has(f.key)).map((field) =>
			field.key === 'level-type'
				? { ...field, options: levelTypeOptionsFor(instance.minecraftVersion) }
				: field
		),
		groups: [...PROPERTY_GROUPS],
		running: summary.running,
		hasIcon: await fs.access(path.join(instance.path, 'server-icon.png')).then(() => true, () => false),
		raw: serialiseProperties(parsed.values)
	};
};

export const actions: Actions = {
	save: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const current = (await readProperties(instance.path)).values;
		const next: Record<string, string> = {
			...current,
			...propertiesFromForm(form, PROPERTY_SCHEMA.filter((f) => !MANAGED_KEYS.has(f.key)))
		};

		for (const [key, value] of form.entries()) {
			const match = key.match(/^extra:(.+)$/);
			if (match) next[match[1]] = String(value);
		}

		const newPort = Number(next['server-port']);
		if (Number.isFinite(newPort) && newPort !== instance.serverPort) {
			const conflict = portConflict(newPort, instance.id);
			if (conflict) return fail(400, { ok: false, message: conflict });
			db.update(serverInstances)
				.set({ serverPort: newPort, updatedAt: Date.now() })
				.where(eq(serverInstances.id, instance.id))
				.run();
		}

		await writeProperties(instance.path, next);
		await syncPortsToProperties(requireInstance(instance.id));

		return {
			ok: true,
			message: 'Saved. Restart the server for the changes to take effect.'
		};
	},

	saveRaw: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const raw = String((await request.formData()).get('raw') ?? '');
		const parsed = parseProperties(raw);
		if (Object.keys(parsed.values).length === 0) {
			return fail(400, { ok: false, message: 'That does not look like a properties file.' });
		}
		await writeProperties(instance.path, parsed.values);
		await syncPortsToProperties(instance);
		return { ok: true, message: 'File written. Restart to apply.' };
	}
};
