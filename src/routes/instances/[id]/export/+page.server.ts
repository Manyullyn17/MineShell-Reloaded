import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireInstance } from '#lib/server/instances.js';
import { FORMATS, planExport, startExport, type ExportFormat } from '#lib/server/packexport.js';

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	// Hashing the mods and asking Modrinth which are server-only takes a moment; the page shows first.
	return { formats: FORMATS, plan: planExport(instance) };
};

export const actions: Actions = {
	export: async ({ params, request }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const format = String(form.get('format') ?? '') as ExportFormat;
		if (!FORMATS.some((f) => f.id === format)) return fail(400, { ok: false, message: 'Pick a format.' });
		const name = String(form.get('name') ?? '').trim() || instance.name;
		const version = String(form.get('version') ?? '').trim() || new Date().toISOString().slice(0, 10);
		const taskId = await startExport(instance, {
			format,
			name,
			version,
			mods: form.getAll('mod').map(String),
			folders: form.getAll('folder').map(String)
		});
		return { ok: true, taskId };
	}
};
