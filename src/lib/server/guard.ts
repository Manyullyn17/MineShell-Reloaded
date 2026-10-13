import { redirect } from '@sveltejs/kit';
import { dev } from '$app/env';
import { authEnabled, ownerExists, sessionUser, SESSION_COOKIE } from './auth';
import { loadAccess, REFUSED } from './access';
import { FULL_ACCESS, NO_ACCESS } from '#lib/shared/access.js';
import { decide } from './access/check';

/**
 * Every request's access decision, in one place (hooks.server.ts only calls
 * it). Kept free of boot side effects so it can be tested directly.
 */

/** Paths reachable without a session. */
const PUBLIC_PATHS = ['/login', '/setup'];
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * A browser request that changes state but was sent by a page on another
 * site - or another port on the same machine. Browsers always send Origin on
 * such requests. Only the host is compared, not the scheme: MineShell is
 * reached by raw IP, alternate hostnames and through TLS-terminating proxies,
 * which is what tripped SvelteKit's own full-origin check (disabled in
 * vite.config.ts). Requests without Origin (scripts, curl) are not
 * cross-site requests from a browser and pass.
 */
export function isCrossSiteRequest(request: Request): boolean {
	if (!STATE_CHANGING.has(request.method)) return false;
	const origin = request.headers.get('origin');
	if (!origin) return false;
	let originHost: string;
	try {
		originHost = new URL(origin).host.toLowerCase();
	} catch {
		return true; // "null" and other opaque origins
	}
	const hosts = [request.headers.get('host'), ...(request.headers.get('x-forwarded-host') ?? '').split(',')]
		.map((h) => h?.trim().toLowerCase())
		.filter(Boolean);
	return !hosts.includes(originHost);
}

type GuardEvent = {
	request: Request;
	url: URL;
	route: { id: string | null };
	params: Record<string, string>;
	cookies: { get: (name: string) => string | undefined };
	locals: App.Locals;
};

const UNLISTED = 'MineShell has no access rule for that, so nobody may do it.';

/**
 * A refusal in the form the asker reads: an enhanced form gets an action
 * error (shown like any failed action), a script JSON, a browser text.
 */
function refused(request: Request, message: string): Response {
	if (request.headers.get('x-sveltekit-action') === 'true') {
		return Response.json({ type: 'error', error: { message } }, { status: 403 });
	}
	if (request.headers.get('accept')?.includes('application/json')) return Response.json({ message }, { status: 403 });
	return new Response(message, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** The access policy (access/policy.ts) applied to a request that got past sign-in. */
function checkPolicy(event: GuardEvent): Response | null {
	const decision = decide(
		{
			method: event.request.method,
			url: event.url,
			routeId: event.route.id,
			params: event.params,
			signedIn: event.locals.authenticated
		},
		event.locals.access
	);
	if (decision.allowed) return null;
	// A route or action without an entry: refused for everyone, loudly while developing.
	if (decision.unlisted && dev) console.error(`[mineshell] not in the access policy (src/lib/server/access/policy.ts): ${decision.what}`);
	// A page: its load must not run (its data would reach the browser), so show
	// the refusal on a page of its own, inside MineShell's frame.
	if (decision.page) {
		const from = event.url.pathname.replace(/\/__data\.json$/, '');
		redirect(303, `/denied?${new URLSearchParams({ from, ...(decision.unlisted ? { unlisted: '1' } : {}) })}`);
	}
	return refused(event.request, decision.unlisted ? UNLISTED : REFUSED);
}

/**
 * Returns a response to send instead of the page (cross-site request), throws
 * a redirect (setup / login), or returns null to carry on.
 */
export function guard(event: GuardEvent): Response | null {
	if (isCrossSiteRequest(event.request)) {
		return new Response('Cross-site request blocked.', { status: 403 });
	}

	const required = authEnabled();
	event.locals.authRequired = required;
	event.locals.user = null;
	if (!required) {
		event.locals.authenticated = true;
		event.locals.access = FULL_ACCESS;
		return checkPolicy(event);
	}

	event.locals.user = sessionUser(event.cookies.get(SESSION_COOKIE));
	event.locals.authenticated = event.locals.user !== null;
	event.locals.access = event.locals.user ? loadAccess(event.locals.user) : NO_ACCESS;
	const pathname = event.url.pathname;
	const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

	// A fresh install has no account yet, so send the first visitor to setup.
	// (In SvelteKit 2, redirect() throws by itself.)
	if (!ownerExists() && pathname !== '/setup') redirect(303, '/setup');
	if (!event.locals.authenticated && !isPublic) {
		redirect(303, `/login?next=${encodeURIComponent(pathname + event.url.search)}`);
	}
	// Only the page: signing out posts to /login?/logout, which this used to send home unrun.
	if (event.locals.authenticated && pathname === '/login' && event.request.method === 'GET') redirect(303, '/');
	return checkPolicy(event);
}
