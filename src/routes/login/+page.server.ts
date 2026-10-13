import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	SESSION_COOKIE,
	clearLoginAttempts,
	createSession,
	destroySession,
	loginThrottled,
	ownerExists,
	recordFailedLogin,
	sessionCookieOptions,
	soleUsername,
	verifyLogin
} from '#lib/server/auth.js';
import { sameOriginPath } from '#lib/shared/links.js';

export const load: PageServerLoad = async ({ url }) => {
	if (!ownerExists()) redirect(303, '/setup');
	return { next: sameOriginPath(url.searchParams.get('next'), url.origin), username: soleUsername() };
};

export const actions: Actions = {
	login: async ({ request, cookies, getClientAddress, url }) => {
		const ip = getClientAddress();
		const form = await request.formData();
		const username = String(form.get('username') ?? '');
		const password = String(form.get('password') ?? '');

		if (loginThrottled(ip, username)) {
			return fail(429, { message: 'Too many attempts. Wait a few minutes and try again.', username });
		}

		const user = verifyLogin(username, password);
		if (!user) {
			recordFailedLogin(ip, username);
			return fail(401, { message: 'That username and password do not match.', username });
		}

		clearLoginAttempts(ip);
		const session = createSession(user.id, request.headers.get('user-agent'));
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
