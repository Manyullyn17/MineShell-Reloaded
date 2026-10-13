import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	AccountError,
	deleteAccount,
	getAccount,
	grantsOf,
	mayManage,
	removeGrant,
	resetAccountPassword,
	saveGrant,
	setAccountDisabled,
	setAccountFlags,
	type Account
} from '#lib/server/accounts.js';
import { destroyUserSessions } from '#lib/server/auth.js';
import { NO_ACCESS_REASON } from '#lib/server/access.js';
import { audit, getInstance, listInstances } from '#lib/server/instances.js';
import { listPlayerData } from '#lib/server/playerdata.js';
import { isInstancePermission } from '#lib/shared/access.js';

/**
 * One account, for a global admin: its flags, its state, and its access per
 * server. Who may change it: accounts.ts `mayManage` (the owner: nobody here;
 * a global admin: the owner; anyone else: any global admin).
 */
export const load: PageServerLoad = async ({ params, locals }) => {
	const account = getAccount(params.userId);
	if (!account) error(404, 'No such account.');
	const servers = listInstances().map((i) => ({ id: i.id, name: i.name }));
	return {
		account,
		manageable: mayManage(locals.access, account),
		owner: locals.access.owner,
		self: locals.user?.id === account.id,
		servers,
		grants: grantsOf(account.id),
		// Streamed: each server's known players (names from its own files and the profile cache, no lookups), for choosing players.
		players: Promise.all(
			listInstances().map(async (i) => [i.id, (await listPlayerData(i).catch(() => [])).map((p) => ({ uuid: p.uuid, name: p.name }))] as const)
		).then((entries) => Object.fromEntries(entries))
	};
};

/** The account the action is about, if the one asking may change it. */
function target(params: { userId: string }, locals: App.Locals): Account {
	const account = getAccount(params.userId);
	if (!account) error(404, 'No such account.');
	if (!mayManage(locals.access, account)) error(403, NO_ACCESS_REASON);
	return account;
}

const by = (locals: App.Locals) => locals.user?.username ?? 'MineShell';

/** UUIDs from the ticked players and a free text field (any separators), lower case. */
function uuidsFrom(form: FormData, ticked: string, typed: string): string[] {
	const extra = String(form.get(typed) ?? '')
		.toLowerCase()
		.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
	return [...new Set([...form.getAll(ticked).map((u) => String(u).toLowerCase()), ...(extra ?? [])])];
}

const scope = (value: FormDataEntryValue | null) => (value === 'all' || value === 'selected' ? value : 'none');

export const actions: Actions = {
	flags: async ({ request, params, locals }) => {
		const account = target(params, locals);
		const form = await request.formData();
		const globalAdmin = form.get('globalAdmin') === 'on';
		// Making and unmaking MineShell admins is the owner's alone.
		if (globalAdmin !== account.isGlobalAdmin && !locals.access.owner) {
			return fail(403, { ok: false, message: 'Only the owner makes or unmakes MineShell admins.' });
		}
		setAccountFlags(account.id, { globalAdmin, canCreate: form.get('canCreate') === 'on' });
		audit('account.flags', { detail: `${account.username}: admin ${globalAdmin}, create ${form.get('canCreate') === 'on'}; by ${by(locals)}` });
		return { ok: true, message: 'Saved.' };
	},

	disable: async ({ params, locals }) => {
		const account = target(params, locals);
		setAccountDisabled(account.id, true);
		audit('account.disabled', { detail: `${account.username} by ${by(locals)}` });
		return { ok: true, message: `${account.username} is disabled and signed out everywhere.` };
	},

	enable: async ({ params, locals }) => {
		const account = target(params, locals);
		setAccountDisabled(account.id, false);
		audit('account.enabled', { detail: `${account.username} by ${by(locals)}` });
		return { ok: true, message: `${account.username} can sign in again.` };
	},

	resetPassword: async ({ params, locals }) => {
		const account = target(params, locals);
		const password = resetAccountPassword(account.id);
		audit('account.password_reset', { detail: `${account.username} by ${by(locals)}` });
		// Shown once, here; only its hash is kept.
		return { ok: true, message: `${account.username} has a new one-time password.`, reset: { username: account.username, password } };
	},

	signOut: async ({ params, locals }) => {
		const account = target(params, locals);
		destroyUserSessions(account.id);
		audit('account.signed_out', { detail: `${account.username} by ${by(locals)}` });
		return { ok: true, message: `${account.username} is signed out everywhere.` };
	},

	delete: async ({ request, params, locals }) => {
		const account = target(params, locals);
		if (String((await request.formData()).get('confirm') ?? '').trim() !== account.username) {
			return fail(400, { ok: false, message: `Type ${account.username} to confirm.` });
		}
		deleteAccount(account.id);
		audit('account.deleted', { detail: `${account.username} by ${by(locals)}` });
		redirect(303, '/settings/users');
	},

	access: async ({ request, params, locals }) => {
		const account = target(params, locals);
		const form = await request.formData();
		const instance = getInstance(String(form.get('instanceId') ?? ''));
		if (!instance) return fail(404, { ok: false, message: 'That server no longer exists.' });
		const level = form.get('level');
		try {
			if (level === 'none') {
				removeGrant(account.id, instance.id);
			} else {
				saveGrant(account.id, instance.id, {
					admin: level === 'admin',
					permissions: form.getAll('permission').map(String).filter(isInstancePermission),
					playerView: scope(form.get('playerView')),
					playerEdit: scope(form.get('playerEdit')),
					viewUuids: uuidsFrom(form, 'viewUuid', 'viewExtra'),
					editUuids: uuidsFrom(form, 'editUuid', 'editExtra')
				});
			}
		} catch (err) {
			if (err instanceof AccountError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
		audit('account.access', { instanceId: instance.id, detail: `${account.username}: ${level}; by ${by(locals)}` });
		return { ok: true, message: `Saved ${account.username}'s access to ${instance.name}.` };
	}
};
