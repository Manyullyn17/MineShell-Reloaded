import { redirect, type Handle } from '@sveltejs/kit';
import { authEnabled, passwordIsSet, sessionValid, SESSION_COOKIE } from '$lib/server/auth';
import { boot } from '$lib/server/boot';

boot();

/** Paths reachable without a session. */
const PUBLIC_PATHS = ['/login', '/setup'];

export const handle: Handle = async ({ event, resolve }) => {
	const required = authEnabled();
	event.locals.authRequired = required;

	if (!required) {
		event.locals.authenticated = true;
		return resolve(event);
	}

	event.locals.authenticated = sessionValid(event.cookies.get(SESSION_COOKIE));

	const pathname = event.url.pathname;
	const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

	// A fresh install has no password yet, so send the first visitor to setup.
	if (!passwordIsSet() && pathname !== '/setup') {
		redirect(303, '/setup');
	}

	if (!event.locals.authenticated && !isPublic) {
		const next = encodeURIComponent(pathname + event.url.search);
		redirect(303, `/login?next=${next}`);
	}

	if (event.locals.authenticated && pathname === '/login') {
		redirect(303, '/');
	}

	return resolve(event);
};
