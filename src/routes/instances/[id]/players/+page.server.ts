import { fail } from '@sveltejs/kit';
import { requireAccess } from '#lib/server/access.js';
import { can } from '#lib/shared/access.js';
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
import { listPlayerData, PlayerDataError, removePlayerFiles } from '#lib/server/playerdata.js';
import { lookUpProfiles } from '#lib/server/profiles.js';
import { playtimes } from '#lib/server/history.js';
import { leaderboard } from '#lib/server/playerstats.js';

export const load: PageServerLoad = async ({ params, locals }) => {
	const instance = requireInstance(params.id);
	const all = await loadPlayerLists(instance);
	// IP addresses are for whoever manages bans, not for everyone who may see the server.
	const lists = can(locals.access, instance.id, 'players.manage') ? all : { ...all, ipBans: [] };
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
		playtimes: playtimes(instance.id),
		// Streamed: the listed players' stats files, for the leaderboard.
		leaderboard: leaderboard(instance, new Set(playerFiles.map((f) => f.uuid))).catch(() => null)
	};
};

/** An operator runs commands in the game, so changing the ops list is console access too. */
function listChange(locals: App.Locals, instanceId: string, list: ListName): ListName {
	if (list === 'ops') requireAccess(locals, instanceId, 'console.command');
	return list;
}

function listFrom(form: FormData): ListName {
	const value = String(form.get('list') ?? 'whitelist');
	return (['whitelist', 'ops', 'bans', 'ipBans'] as ListName[]).includes(value as ListName)
		? (value as ListName)
		: 'whitelist';
}

export const actions: Actions = {
	add: async ({ request, params, locals }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const result = await addPlayer(instance, listChange(locals, instance.id, listFrom(form)), String(form.get('name') ?? ''), {
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

	remove: async ({ request, params, locals }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const result = await removePlayer(instance, listChange(locals, instance.id, listFrom(form)), String(form.get('name') ?? ''));
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

	removeFiles: async ({ request, params, locals }) => {
		const instance = requireInstance(params.id);
		const uuid = String((await request.formData()).get('uuid') ?? '').toLowerCase();
		requireAccess(locals, instance.id, 'players.data.edit', uuid);
		try {
			const removed = await removePlayerFiles(instance, uuid);
			return { ok: true, removed: true, message: `Removed ${removed.length} ${removed.length === 1 ? 'file' : 'files'} to the trash (Files).` };
		} catch (err) {
			if (err instanceof PlayerDataError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
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
