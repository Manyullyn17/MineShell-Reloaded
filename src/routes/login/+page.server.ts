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
	recordFailedLogin,
	sessionCookieOptions
} from '$lib/server/auth';
import { sameOriginPath } from '$lib/shared/links';

export const load: PageServerLoad = async ({ url }) => {
	if (!passwordIsSet()) redirect(303, '/setup');
	return { next: sameOriginPath(url.searchParams.get('next'), url.origin) };
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
		cookies.set(SESSION_COOKIE, session.id, sessionCookieOptions(request, url));

		// Only ever back into MineShell: "//evil.example" also starts with "/".
		redirect(303, sameOriginPath(String(form.get('next') ?? '/'), url.origin));
	},

	logout: async ({ cookies }) => {
		destroySession(cookies.get(SESSION_COOKIE));
		cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/login');
	}
};
