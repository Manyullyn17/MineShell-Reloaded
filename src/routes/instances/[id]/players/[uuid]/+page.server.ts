import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireInstance } from '$lib/server/instances';
import {
	listBackups,
	onlinePlayerIds,
	parseEdits,
	PlayerDataError,
	playerView,
	readPlayerData,
	restorePlayerBackup,
	savePlayerData
} from '$lib/server/playerdata';
import { addCustomField, customFieldViews, listCustomFields, remapCustomField, removeCustomField } from '$lib/server/playerfields';

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	let data;
	try {
		data = await readPlayerData(instance, params.uuid);
	} catch (err) {
		if (err instanceof PlayerDataError) error(404, err.message);
		throw err;
	}
	const online = await onlinePlayerIds(instance);
	const uuid = params.uuid.toLowerCase();
	return {
		uuid,
		name: data.name,
		version: data.version,
		view: playerView(data.file),
		customFields: customFieldViews(data.file.root, listCustomFields(instance.id)),
		backups: await listBackups(instance, uuid),
		// Why it cannot be edited right now, if it cannot.
		locked:
			online === null
				? 'The server is running and MineShell cannot tell who is online (RCON is not answering). Stop the server to edit player data.'
				: online.has(uuid)
					? `${data.name ?? 'This player'} is online. The server would overwrite any change when they leave, so editing waits until they have.`
					: null
	};
};

function pathFrom(form: FormData): unknown {
	try {
		return JSON.parse(String(form.get('path') ?? 'null'));
	} catch {
		return null;
	}
}

function refused(err: unknown) {
	if (err instanceof PlayerDataError) return fail(400, { ok: false, message: err.message });
	throw err;
}

export const actions: Actions = {
	edit: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			let raw: unknown;
			try {
				raw = JSON.parse(String(form.get('edits') ?? '[]'));
			} catch {
				raw = null;
			}
			await savePlayerData(instance, params.uuid, String(form.get('version') ?? ''), parseEdits(raw));
			return { ok: true, message: 'Saved.' };
		} catch (err) {
			return refused(err);
		}
	},

	addField: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			addCustomField(instance.id, { label: String(form.get('label') ?? ''), path: pathFrom(form), kind: String(form.get('kind') ?? '') });
			return { ok: true, message: 'Field added. It shows for every player of this server.' };
		} catch (err) {
			return refused(err);
		}
	},

	remapField: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			remapCustomField(instance.id, Number(form.get('id')), pathFrom(form), String(form.get('kind') ?? '') || undefined);
			return { ok: true, message: 'Field moved to the new place.' };
		} catch (err) {
			return refused(err);
		}
	},

	removeField: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		removeCustomField(instance.id, Number((await request.formData()).get('id')));
		return { ok: true, message: 'Field removed.' };
	},

	restore: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		try {
			await restorePlayerBackup(instance, params.uuid, String(form.get('version') ?? ''), String(form.get('backup') ?? ''));
			return { ok: true, message: 'Backup restored. The data it replaced was backed up too.' };
		} catch (err) {
			return refused(err);
		}
	}
};
