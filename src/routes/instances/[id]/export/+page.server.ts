import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireInstance } from '#lib/server/instances.js';
import { primaryLanAddress } from '#lib/server/network.js';
import { FORMATS, planExport, startExport, type ExportFormat } from '#lib/server/packexport.js';

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	// Hashing the mods and asking Modrinth which are server-only takes a moment; the page shows first.
	// The server list's address on this network; the page prefers playit's public one when there is a tunnel.
	const port = instance.serverPort === 25565 ? '' : `:${instance.serverPort}`;
	return { formats: FORMATS, plan: planExport(instance), lanAddress: `${primaryLanAddress()}${port}` };
};

export const actions: Actions = {
	export: async ({ params, request }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const format = String(form.get('format') ?? '') as ExportFormat;
		if (!FORMATS.some((f) => f.id === format)) return fail(400, { ok: false, message: 'Pick a format.' });
		const name = String(form.get('name') ?? '').trim() || instance.name;
		const version = String(form.get('version') ?? '').trim() || new Date().toISOString().slice(0, 10);
		let serverEntry: { name: string; address: string } | null = null;
		if (form.get('serverList') === 'on') {
			const address = String(form.get('serverAddress') ?? '').trim();
			if (!address || address.length > 253 || /\s/.test(address)) return fail(400, { ok: false, message: 'Give the address players join, like play.example.com or 192.168.1.20:25566.' });
			serverEntry = { name: String(form.get('serverName') ?? '').trim() || instance.name, address };
		}
		const taskId = await startExport(instance, {
			format,
			name,
			version,
			mods: form.getAll('mod').map(String),
			folders: form.getAll('folder').map(String),
			serverEntry
		});
		return { ok: true, taskId };
	}
};
