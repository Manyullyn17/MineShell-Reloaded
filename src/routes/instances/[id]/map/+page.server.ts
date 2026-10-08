import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { InstanceError, JavaMissingError, requireInstance } from '#lib/server/instances.js';
import { isJavaVendor } from '#lib/server/javadownload.js';
import { deleteMapData, installMapMod, mapStatus, renderMap, saveMapSchedule, saveMapSettings, validMapSchedule } from '#lib/server/worldmap.js';
import { serverWorldName } from '#lib/server/packworld.js';
import { sendCommand, summarise } from '#lib/server/instances.js';

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	return { map: await mapStatus(instance) };
};

function refused(err: unknown, action: string) {
	if (err instanceof JavaMissingError) return fail(400, { ok: false, message: err.message, javaMissing: { major: err.major, action } });
	if (err instanceof InstanceError) return fail(400, { ok: false, message: err.message });
	return fail(500, { ok: false, message: err instanceof Error ? err.message : 'Something went wrong.' });
}

export const actions: Actions = {
	/** The first time: Mojang's EULA accepted for this server's map, then the first render. */
	setup: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		if (form.get('eula') !== 'on') return fail(400, { ok: false, message: 'Tick the box to accept Mojang’s EULA first.' });
		saveMapSettings(instance.id, { eulaAccepted: true });
		try {
			await renderMap(instance, { downloadJava: vendorFrom(form) });
			return { ok: true, message: 'Rendering the map. Follow it in Tasks; the first time takes longest.' };
		} catch (err) {
			return refused(err, 'setup');
		}
	},

	render: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			await renderMap(instance, { force: form.get('force') === 'on', downloadJava: vendorFrom(form) });
			return { ok: true, message: 'Updating the map. Follow it in Tasks.' };
		} catch (err) {
			return refused(err, 'render');
		}
	},

	/** Dynmap and DynmapBlockScan (1.12.2), or the BlueMap mod (1.13+). */
	installMod: async ({ params }) => {
		const instance = requireInstance(params.id);
		try {
			await installMapMod(instance);
			return { ok: true, message: 'Installing. The map mod loads the next time the server starts.' };
		} catch (err) {
			return refused(err, 'installMod');
		}
	},

	/** Dynmap draws chunks as they change; this has it draw the whole world once. */
	dynmapRender: async ({ params }) => {
		const instance = requireInstance(params.id);
		if (!(await summarise(instance)).running) return fail(400, { ok: false, message: 'Start the server first: Dynmap renders inside it.' });
		try {
			const answer = await sendCommand(instance, `dynmap fullrender ${await serverWorldName(instance.path)}`);
			return { ok: true, message: answer.trim() || 'Dynmap is rendering the world; tiles fill in as it goes.' };
		} catch (err) {
			return refused(err, 'dynmapRender');
		}
	},

	schedule: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const schedule = validMapSchedule(Object.fromEntries(form));
		saveMapSchedule(instance.id, schedule);
		return { ok: true, message: schedule.every === 'off' ? 'The map updates only when you ask.' : 'Saved the schedule.' };
	},

	delete: async ({ params }) => {
		const instance = requireInstance(params.id);
		try {
			await deleteMapData(instance.id, { keepSettings: true });
			return { ok: true, message: 'Deleted the rendered map. The world is untouched.' };
		} catch (err) {
			return refused(err, 'delete');
		}
	}
};

function vendorFrom(form: FormData) {
	const vendor = form.get('downloadJava');
	return isJavaVendor(vendor) ? vendor : undefined;
}
