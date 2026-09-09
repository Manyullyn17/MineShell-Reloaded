import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	SESSION_COOKIE,
	checkPassword,
	clearLoginAttempts,
	createSession,
	destroySession,
	loginThrottled,
	passwordIsSet,
	recordFailedLogin
} from '$lib/server/auth';

export const load: PageServerLoad = async ({ url }) => {
	if (!passwordIsSet()) redirect(303, '/setup');
	return { next: url.searchParams.get('next') ?? '/' };
};

export const actions: Actions = {
	login: async ({ request, cookies, getClientAddress, url }) => {
		const ip = getClientAddress();
		if (loginThrottled(ip)) {
			return fail(429, { message: 'Too many attempts. Wait a few minutes and try again.' });
		}

		const form = await request.formData();
		const password = String(form.get('password') ?? '');

		if (!checkPassword(password)) {
			recordFailedLogin(ip);
			return fail(401, { message: 'That password does not match.' });
		}

		clearLoginAttempts(ip);
		const session = createSession(request.headers.get('user-agent'));
		cookies.set(SESSION_COOKIE, session.id, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: url.protocol === 'https:',
			maxAge: 60 * 60 * 24 * 30
		});

		const next = String(form.get('next') ?? '/');
		redirect(303, next.startsWith('/') ? next : '/');
	},

	logout: async ({ cookies }) => {
		destroySession(cookies.get(SESSION_COOKIE));
		cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/login');
	}
};
