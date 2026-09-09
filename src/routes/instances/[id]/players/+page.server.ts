import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireInstance } from '$lib/server/instances';
import {
	addPlayer,
	kickPlayer,
	loadPlayerLists,
	removePlayer,
	setWhitelistEnforced,
	type ListName
} from '$lib/server/players';
import { onlinePlayers } from '$lib/server/instances';

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	const lists = await loadPlayerLists(instance);
	const online = lists.serverRunning ? await onlinePlayers(instance) : null;
	return { lists, online };
};

function listFrom(form: FormData): ListName {
	const value = String(form.get('list') ?? 'whitelist');
	return (['whitelist', 'ops', 'bans'] as ListName[]).includes(value as ListName)
		? (value as ListName)
		: 'whitelist';
}

export const actions: Actions = {
	add: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const result = await addPlayer(instance, listFrom(form), String(form.get('name') ?? ''));
		return result.ok ? result : fail(400, result);
	},

	remove: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const result = await removePlayer(instance, listFrom(form), String(form.get('name') ?? ''));
		return result.ok ? result : fail(400, result);
	},

	whitelist: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const enabled = (await request.formData()).get('enabled') === 'true';
		await setWhitelistEnforced(instance, enabled);
		return {
			ok: true,
			message: enabled
				? 'Whitelist is on. Only listed players can join.'
				: 'Whitelist is off. Anyone can join.'
		};
	},

	kick: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const name = String(form.get('name') ?? '');
		const response = await kickPlayer(instance, name, String(form.get('reason') ?? ''));
		if (response === null) {
			return fail(400, { ok: false, message: 'The server is not reachable over RCON.' });
		}
		return { ok: true, message: `Kicked ${name}.` };
	}
};
