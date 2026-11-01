import net from 'node:net';
import os from 'node:os';
import { redirect } from '@sveltejs/kit';
import { dev } from '$app/env';
import { EXTRA_HOSTS } from './config';
import { authEnabled, ownerExists, sessionUser, SESSION_COOKIE } from './auth';
import { loadAccess, NO_ACCESS_REASON } from './access';
import { FULL_ACCESS, NO_ACCESS } from '#lib/shared/access.js';
import { decide } from './access/check';

/**
 * Every request's access decision, in one place (hooks.server.ts only calls
 * it). Kept free of boot side effects so it can be tested directly.
 */

/** Paths reachable without a session. */
const PUBLIC_PATHS = ['/login', '/setup'];
/**
 * The Map tab's sandboxed map content (mapframe.ts): its requests carry no
 * cookie and, from the sandbox, `Origin: null`. The token in the path is
 * checked instead, and stands in for the cross-site check too: another site
 * cannot know it.
 */
const MAP_FRAMES = '/maps/';
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

/**
 * What a visitor who is not signed in may send: the sign-in and setup forms
 * are a few hundred bytes. The installer sets BODY_SIZE_LIMIT=Infinity for
 * world uploads, so without this anyone reaching the port could post
 * gigabytes to /login, which reads the whole form into memory.
 */
const ANONYMOUS_BODY_LIMIT = 64 * 1024;

export function anonymousBodyTooBig(request: Request): boolean {
	if (!STATE_CHANGING.has(request.method)) return false;
	const length = request.headers.get('content-length');
	// No length: sent in chunks, of any size.
	if (length === null) return request.body !== null;
	return !(Number(length) <= ANONYMOUS_BODY_LIMIT);
}

/** Names only a local network gives out; nobody on the internet can point them at this machine. */
const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.localdomain', '.localhost', '.ts.net'];

/**
 * With MINESHELL_AUTH=off, whether a request's Host is a name this machine is
 * reached by. A site's own name can be made to point at a LAN address (DNS
 * rebinding): its page then talks to MineShell as same-origin, which the
 * cross-site check cannot tell apart, and without sign-in every request may
 * do everything. So only an address, a one-word or local network name, this
 * machine's name, or one listed in MINESHELL_HOSTS (a reverse proxy's) is
 * answered. With sign-in, a rebound page has no session cookie to send.
 */
export function hostAllowedWithoutAuth(host: string | null): boolean {
	if (!host) return true;
	let name: string;
	try {
		name = new URL(`http://${host}`).hostname.toLowerCase().replace(/\.$/, '');
	} catch {
		return false;
	}
	if (name.startsWith('[') || net.isIP(name)) return true;
	if (!name.includes('.')) return true;
	if (LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
	if (name === os.hostname().toLowerCase()) return true;
	return EXTRA_HOSTS.includes(name);
}

/**
 * Headers every response gets: no other site (or another port on this
 * machine, which shares the cookies) may show MineShell in a frame, so a
 * page cannot overlay its buttons with its own. Its own pages may: the Map
 * tab frames the map.
 */
export function withSecurityHeaders(response: Response): Response {
	response.headers.set('x-frame-options', 'SAMEORIGIN');
	if (!response.headers.has('content-security-policy')) response.headers.set('content-security-policy', "frame-ancestors 'self'");
	return response;
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
 * All an account given its password by someone else may reach until it picks
 * its own: its account page (and the change there) and signing out.
 */
const FORCED_CHANGE_ROUTES = new Set(['/account', '/login']);

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
	return refused(event.request, decision.unlisted ? UNLISTED : NO_ACCESS_REASON);
}

/**
 * Returns a response to send instead of the page (cross-site request), throws
 * a redirect (setup / login), or returns null to carry on.
 */
export function guard(event: GuardEvent): Response | null {
	const mapFrame = event.url.pathname.startsWith(MAP_FRAMES);
	if (isCrossSiteRequest(event.request) && !mapFrame) {
		return new Response('Cross-site request blocked.', { status: 403 });
	}

	const required = authEnabled();
	event.locals.authRequired = required;
	event.locals.user = null;
	if (!required) {
		event.locals.authenticated = true;
		event.locals.access = FULL_ACCESS;
		if (!hostAllowedWithoutAuth(event.request.headers.get('host'))) {
			return new Response(
				`MineShell runs without sign-in (MINESHELL_AUTH=off), so it answers only to this machine's addresses and local names. To reach it as ${event.url.hostname}, add that name to MINESHELL_HOSTS.`,
				{ status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } }
			);
		}
		return checkPolicy(event);
	}

	event.locals.user = sessionUser(event.cookies.get(SESSION_COOKIE));
	event.locals.authenticated = event.locals.user !== null;
	event.locals.access = event.locals.user ? loadAccess(event.locals.user) : NO_ACCESS;
	const pathname = event.url.pathname;
	const isPublic = mapFrame || PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

	if (!event.locals.authenticated && !mapFrame && anonymousBodyTooBig(event.request)) {
		return new Response('Sign in first.', { status: 413, headers: { 'content-type': 'text/plain; charset=utf-8' } });
	}
	// A fresh install has no account yet, so send the first visitor to setup.
	// (In SvelteKit 2, redirect() throws by itself.)
	if (!ownerExists() && pathname !== '/setup') redirect(303, '/setup');
	if (!event.locals.authenticated && !isPublic) {
		redirect(303, `/login?next=${encodeURIComponent(pathname + event.url.search)}`);
	}
	// Only the page: signing out posts to /login?/logout, which this used to send home unrun.
	if (event.locals.authenticated && pathname === '/login' && event.request.method === 'GET') redirect(303, '/');
	if (event.locals.user?.mustChangePassword && !mapFrame && !FORCED_CHANGE_ROUTES.has(event.route.id ?? '')) {
		if (event.request.method === 'GET' && !pathname.startsWith('/api/')) redirect(303, '/account');
		return refused(event.request, 'Pick your own password first, on your account page.');
	}
	return checkPolicy(event);
}
