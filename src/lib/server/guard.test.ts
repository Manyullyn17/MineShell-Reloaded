import { isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Tests run with MINESHELL_AUTH=off; the guard's auth path needs it on. The
// owner cannot be deleted, so "before setup" is the mocked ownerExists.
const authControl = vi.hoisted(() => ({ enabled: true, setUp: true }));
vi.mock('./auth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./auth')>();
	return { ...actual, authEnabled: () => authControl.enabled, ownerExists: () => authControl.setUp && actual.ownerExists() };
});

const { guard, isCrossSiteRequest } = await import('./guard');
const { createSession, destroySession, SESSION_COOKIE } = await import('./auth');
const { db } = await import('./db');
const { users } = await import('./db/schema');
const { owner, otherUser } = await import('../../../tests/helpers/auth');

const HOST = '192.168.0.200:5173';

function request(method: string, headers: Record<string, string> = {}) {
	return new Request(`http://${HOST}/instances/a?/power`, { method, headers: { host: HOST, ...headers } });
}

function event(path: string, opts: { session?: string; method?: string; headers?: Record<string, string> } = {}) {
	const url = new URL(path, `http://${HOST}`);
	return {
		request: new Request(url, { method: opts.method ?? 'GET', headers: { host: HOST, ...(opts.headers ?? {}) } }),
		url,
		cookies: { get: (name: string) => (name === SESSION_COOKIE ? opts.session : undefined) },
		locals: {} as App.Locals
	};
}

/** The redirect guard() throws, or null when it lets the request through. */
function outcome(e: ReturnType<typeof event>): { redirect?: string; status?: number } | null {
	try {
		const response = guard(e);
		return response ? { status: response.status } : null;
	} catch (err) {
		if (isRedirect(err)) return { redirect: err.location };
		throw err;
	}
}

describe('cross-site requests', () => {
	it('refuses state changes sent by another site or another port', () => {
		expect(isCrossSiteRequest(request('POST', { origin: 'http://evil.example' }))).toBe(true);
		expect(isCrossSiteRequest(request('POST', { origin: 'http://192.168.0.200:8080' }))).toBe(true);
		expect(isCrossSiteRequest(request('DELETE', { origin: 'null' }))).toBe(true);
	});

	it('allows the panel itself, however it is reached', () => {
		expect(isCrossSiteRequest(request('POST', { origin: `http://${HOST}` }))).toBe(false);
		// TLS proxy: the browser says https, the app sees http - hosts still match.
		expect(isCrossSiteRequest(request('POST', { origin: `https://${HOST}` }))).toBe(false);
		expect(isCrossSiteRequest(request('POST', { origin: 'https://mc.example', 'x-forwarded-host': 'mc.example' }))).toBe(false);
	});

	it('leaves reads and non-browser clients alone', () => {
		expect(isCrossSiteRequest(request('GET', { origin: 'http://evil.example' }))).toBe(false);
		expect(isCrossSiteRequest(request('POST'))).toBe(false);
	});

	it('blocks before any auth decision, so MINESHELL_AUTH=off is protected too', () => {
		authControl.enabled = false;
		try {
			expect(outcome(event('/instances/a', { method: 'POST', headers: { origin: 'http://evil.example' } }))).toEqual({ status: 403 });
		} finally {
			authControl.enabled = true;
		}
	});
});

describe('auth guard', () => {
	beforeEach(() => {
		authControl.enabled = true;
		authControl.setUp = true;
		owner();
	});

	it('sends everyone to setup until the owner account exists', () => {
		authControl.setUp = false;
		expect(outcome(event('/'))).toEqual({ redirect: '/setup' });
		expect(outcome(event('/login'))).toEqual({ redirect: '/setup' });
		expect(outcome(event('/setup'))).toBeNull();
	});

	it('sends visitors without a session to login, remembering where they were going', () => {
		expect(outcome(event('/settings?tab=x'))).toEqual({ redirect: '/login?next=%2Fsettings%3Ftab%3Dx' });
		expect(outcome(event('/login'))).toBeNull();
		expect(outcome(event('/setup'))).toBeNull();
	});

	it('lets a valid session through as its account and sends it away from the login page', () => {
		const account = owner();
		const session = createSession(account.id, 'test').id;
		const e = event('/settings', { session });
		expect(outcome(e)).toBeNull();
		expect(e.locals.authenticated).toBe(true);
		expect(e.locals.user).toEqual({ id: account.id, username: 'admin', isOwner: true });
		expect(outcome(event('/login', { session }))).toEqual({ redirect: '/' });
	});

	it('lets a signed-in browser post to sign out, rather than sending it home', () => {
		const session = createSession(owner().id, 'test').id;
		expect(outcome(event('/login?/logout', { session, method: 'POST', headers: { origin: `http://${HOST}` } }))).toBeNull();
	});

	it('treats an unknown session like none', () => {
		expect(outcome(event('/settings', { session: 'made-up' }))).toEqual({ redirect: '/login?next=%2Fsettings' });
	});

	it('stops a session at once when it is deleted or its account is disabled', () => {
		const session = createSession(owner().id, 'test').id;
		destroySession(session);
		expect(outcome(event('/settings', { session }))).toEqual({ redirect: '/login?next=%2Fsettings' });

		const account = otherUser();
		const other = createSession(account.id, 'test').id;
		expect(outcome(event('/settings', { session: other }))).toBeNull();
		db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, account.id)).run();
		const e = event('/settings', { session: other });
		expect(outcome(e)).toEqual({ redirect: '/login?next=%2Fsettings' });
		expect(e.locals.user).toBeNull();
	});

	it('lets everything through when auth is off', () => {
		authControl.enabled = false;
		const e = event('/settings');
		expect(outcome(e)).toBeNull();
		expect(e.locals).toMatchObject({ authenticated: true, authRequired: false, user: null });
	});
});
