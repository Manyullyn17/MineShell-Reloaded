import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { destroyUserSessions, listUserSessions, SESSION_COOKIE, setPassword, verifyLogin } from '#lib/server/auth.js';

/** The signed-in account's own page: its password and its sessions. */
export const load: PageServerLoad = ({ locals, cookies }) => {
	const user = locals.user;
	return {
		account: user
			? {
					username: user.username,
					role: user.isOwner ? 'owner' : locals.access.globalAdmin ? 'admin' : 'user',
					mustChangePassword: user.mustChangePassword,
					sessions: listUserSessions(user.id, cookies.get(SESSION_COOKIE))
				}
			: null
	};
};

export const actions: Actions = {
	password: async ({ request, locals, cookies }) => {
		const user = locals.user;
		if (!user) return fail(400, { ok: false, message: 'Sign-in is off (MINESHELL_AUTH=off): there is no account to change.' });
		const form = await request.formData();
		const password = String(form.get('password') ?? '');
		if (password !== String(form.get('confirm') ?? '')) return fail(400, { ok: false, message: 'The two new passwords do not match.' });
		if (user.mustChangePassword) {
			// Just signed in with the one-time password, which proves it: it is not asked again.
			if (verifyLogin(user.username, password)) return fail(400, { ok: false, message: 'Pick a new password, not the one you were given.' });
		} else {
			// The current password too: a session left open somewhere is not enough to take the account.
			const current = String(form.get('current') ?? '');
			if (!verifyLogin(user.username, current)) return fail(400, { ok: false, message: 'Your current password is not right.' });
			if (password === current) return fail(400, { ok: false, message: 'Pick a new password, not the current one.' });
		}
		try {
			setPassword(user.id, password);
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof Error ? err.message : 'Could not save.' });
		}
		if (form.get('signOutEverywhere') === 'on') destroyUserSessions(user.id, cookies.get(SESSION_COOKIE));
		// A forced change done: on to MineShell.
		if (user.mustChangePassword) redirect(303, '/');
		return { ok: true, message: 'Password changed.' };
	},

	signOutOthers: async ({ locals, cookies }) => {
		if (!locals.user) return fail(400, { ok: false, message: 'Sign-in is off (MINESHELL_AUTH=off).' });
		destroyUserSessions(locals.user.id, cookies.get(SESSION_COOKIE));
		return { ok: true, message: 'Signed out everywhere else.' };
	}
};
