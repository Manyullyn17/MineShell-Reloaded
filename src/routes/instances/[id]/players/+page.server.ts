import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireInstance } from '#lib/server/instances.js';
import {
	addPlayer,
	kickPlayer,
	loadPlayerLists,
	removePlayer,
	setOpOptions,
	setWhitelistEnforced,
	type ListName
} from '#lib/server/players.js';
import { onlinePlayers } from '#lib/server/instances.js';
import { listPlayerData } from '#lib/server/playerdata.js';
import { lookUpProfiles } from '#lib/server/profiles.js';
import { playtimes } from '#lib/server/history.js';

export const load: PageServerLoad = async ({ params }) => {
	const instance = requireInstance(params.id);
	const lists = await loadPlayerLists(instance);
	const online = lists.serverRunning ? await onlinePlayers(instance) : null;
	const playerFiles = await listPlayerData(instance);
	const uuids = [
		...playerFiles.map((f) => f.uuid),
		...[...lists.whitelist, ...lists.ops, ...lists.bans].map((e) => e.uuid).filter((u): u is string => !!u)
	];
	return {
		lists,
		online,
		playerFiles,
		// Streamed, from Mojang (cached): skins for the faces, and names for player files the server has none for.
		profiles: uuids.length ? lookUpProfiles(uuids).then((found) => Object.fromEntries(found)) : {},
		playtimes: playtimes(instance.id)
	};
};

function listFrom(form: FormData): ListName {
	const value = String(form.get('list') ?? 'whitelist');
	return (['whitelist', 'ops', 'bans', 'ipBans'] as ListName[]).includes(value as ListName)
		? (value as ListName)
		: 'whitelist';
}

export const actions: Actions = {
	add: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const result = await addPlayer(instance, listFrom(form), String(form.get('name') ?? ''), {
			reason: String(form.get('reason') ?? ''),
			level: Number(form.get('level') ?? 4)
		});
		return result.ok ? result : fail(400, result);
	},

	opOptions: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const result = await setOpOptions(instance, String(form.get('name') ?? ''), {
			level: Number(form.get('level')),
			bypassesPlayerLimit: form.get('bypass') === 'on'
		});
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
