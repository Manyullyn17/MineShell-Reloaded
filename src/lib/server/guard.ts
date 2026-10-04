import { redirect } from '@sveltejs/kit';
import { authEnabled, passwordIsSet, sessionValid, SESSION_COOKIE } from './auth';

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
	cookies: { get: (name: string) => string | undefined };
	locals: App.Locals;
};

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
	if (!required) {
		event.locals.authenticated = true;
		return null;
	}

	event.locals.authenticated = sessionValid(event.cookies.get(SESSION_COOKIE));
	const pathname = event.url.pathname;
	const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

	// A fresh install has no password yet, so send the first visitor to setup.
	// (In SvelteKit 2, redirect() throws by itself.)
	if (!passwordIsSet() && pathname !== '/setup') redirect(303, '/setup');
	if (!event.locals.authenticated && !isPublic) {
		redirect(303, `/login?next=${encodeURIComponent(pathname + event.url.search)}`);
	}
	if (event.locals.authenticated && pathname === '/login') redirect(303, '/');
	return null;
}
