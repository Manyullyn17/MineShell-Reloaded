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

const { guard, isCrossSiteRequest, withSecurityHeaders } = await import('./guard');
const { createSession, destroySession, SESSION_COOKIE } = await import('./auth');
const { db } = await import('./db');
const { users } = await import('./db/schema');
const { owner, otherUser, grant, setAccountFlags } = await import('../../../tests/helpers/auth');
const { createInstance } = await import('../../../tests/helpers/instances');
const { POLICY } = await import('./access/policy');

const HOST = '192.168.0.200:5173';

function request(method: string, headers: Record<string, string> = {}) {
	return new Request(`http://${HOST}/instances/a?/power`, { method, headers: { host: HOST, ...headers } });
}

/**
 * A request as guard() sees it. `route` is the route id (`/instances/[id]`);
 * left out, it is the path when the policy lists that path, else none.
 */
function event(
	path: string,
	opts: { session?: string; method?: string; headers?: Record<string, string>; route?: string | null; params?: Record<string, string> } = {}
) {
	const url = new URL(path, `http://${HOST}`);
	return {
		request: new Request(url, { method: opts.method ?? 'GET', headers: { host: HOST, ...(opts.headers ?? {}) } }),
		url,
		route: { id: opts.route !== undefined ? opts.route : POLICY[url.pathname] ? url.pathname : null },
		params: opts.params ?? {},
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

describe('framing', () => {
	it('is allowed only to MineShell itself, and a page keeps its own policy', () => {
		const plain = withSecurityHeaders(new Response('page'));
		expect(plain.headers.get('x-frame-options')).toBe('SAMEORIGIN');
		expect(plain.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
		const own = withSecurityHeaders(new Response('map', { headers: { 'content-security-policy': "default-src 'self'" } }));
		expect(own.headers.get('content-security-policy')).toBe("default-src 'self'");
		expect(own.headers.get('x-frame-options')).toBe('SAMEORIGIN');
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
		expect(e.locals.user).toEqual({ id: account.id, username: 'admin', isOwner: true, mustChangePassword: false });
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
		expect(outcome(event('/', { session: other }))).toBeNull();
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

describe('access policy', () => {
	const ORIGIN = { origin: `http://${HOST}` };
	const ACTION = { ...ORIGIN, 'x-sveltekit-action': 'true', accept: 'application/json' };

	beforeEach(() => {
		authControl.enabled = true;
		authControl.setUp = true;
	});

	async function server() {
		return createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
	}

	it('lets the owner do anything the policy lists', async () => {
		const { id } = await server();
		const session = createSession(owner().id, null).id;
		const at = (path: string, route: string, method = 'GET') => outcome(event(path, { session, method, route, params: { id }, headers: ORIGIN }));
		expect(at(`/instances/${id}?/delete`, '/instances/[id]/settings', 'POST')).toBeNull();
		expect(at('/settings?/curseforgeKey', '/settings', 'POST')).toBeNull();
		expect(at(`/api/instances/${id}/command`, '/api/instances/[id]/command', 'POST')).toBeNull();
	});

	it('refuses what the policy does not list, the owner and MINESHELL_AUTH=off included', async () => {
		const { id } = await server();
		const session = createSession(owner().id, null).id;
		expect(outcome(event('/somewhere', { session, route: '/somewhere' }))).toEqual({ status: 403 });
		expect(outcome(event(`/instances/${id}?/noSuchAction`, { session, method: 'POST', route: '/instances/[id]', params: { id }, headers: ORIGIN }))).toEqual({ status: 403 });
		expect(outcome(event(`/api/instances/${id}/command`, { session, method: 'DELETE', route: '/api/instances/[id]/command', params: { id }, headers: ORIGIN }))).toEqual({ status: 403 });
		authControl.enabled = false;
		expect(outcome(event('/somewhere', { route: '/somewhere' }))).toEqual({ status: 403 });
		expect(outcome(event(`/instances/${id}?/delete`, { method: 'POST', route: '/instances/[id]/settings', params: { id }, headers: ORIGIN }))).toBeNull();
	});

	it('gives a read-only account the server but none of its actions, and no other server', async () => {
		const mine = await server();
		const other = await server();
		const account = otherUser();
		grant(account.id, mine.id, { permissions: ['view'] });
		const session = createSession(account.id, null).id;
		const get = (route: string, id: string) => outcome(event(route.replace('[id]', id), { session, route, params: { id } }));
		// A refused page goes to /denied: its load never runs, so none of its data is sent.
		const denied = (path: string) => ({ redirect: `/denied?from=${encodeURIComponent(path)}` });
		expect(get('/instances/[id]', mine.id)).toBeNull();
		expect(get('/instances/[id]/mods', mine.id)).toBeNull();
		expect(get('/instances/[id]/console', mine.id)).toEqual(denied(`/instances/${mine.id}/console`));
		expect(get('/instances/[id]/files', mine.id)).toEqual(denied(`/instances/${mine.id}/files`));
		expect(get('/instances/[id]/settings', mine.id)).toEqual(denied(`/instances/${mine.id}/settings`));
		expect(get('/instances/[id]', other.id)).toEqual(denied(`/instances/${other.id}`));
		expect(get('/settings', mine.id)).toEqual(denied('/settings'));
		// Also when the page's data is asked for by a client-side navigation.
		expect(outcome(event(`/instances/${mine.id}/console/__data.json`, { session, route: '/instances/[id]/console', params: { id: mine.id } }))).toEqual(
			denied(`/instances/${mine.id}/console`)
		);

		const post = (path: string, route: string) => event(path, { session, method: 'POST', route, params: { id: mine.id }, headers: ACTION });
		expect(outcome(post(`/instances/${mine.id}?/power`, '/instances/[id]'))).toEqual({ status: 403 });
		expect(outcome(post(`/api/instances/${mine.id}/command`, '/api/instances/[id]/command'))).toEqual({ status: 403 });
	});

	it('answers an enhanced form with an action error, so the page shows it like any failure', async () => {
		const { id } = await server();
		const account = otherUser();
		grant(account.id, id, { permissions: ['view'] });
		const session = createSession(account.id, null).id;
		const response = guard(event(`/instances/${id}?/power`, { session, method: 'POST', route: '/instances/[id]', params: { id }, headers: ACTION }));
		expect(response?.status).toBe(403);
		expect(await response?.json()).toEqual({ type: 'error', error: { message: 'You do not have access to that.' } });
	});

	it('checks player pages against the UUIDs an account may see', async () => {
		const { id } = await server();
		const account = otherUser();
		const steve = '8667ba71-b85a-4004-af54-457a9734eed7';
		const alex = 'ec561538-f3fd-461d-aff5-086b22154bce';
		grant(account.id, id, { permissions: ['view'], playerEdit: [steve] });
		const session = createSession(account.id, null).id;
		const player = (uuid: string, action = '') =>
			outcome(event(`/instances/${id}/players/${uuid}${action}`, { session, method: action ? 'POST' : 'GET', route: '/instances/[id]/players/[uuid]', params: { id, uuid }, headers: ORIGIN }));
		expect(player(steve)).toBeNull();
		expect(player(steve, '?/edit')).toBeNull();
		expect(player(alex)).toEqual({ redirect: `/denied?from=${encodeURIComponent(`/instances/${id}/players/${alex}`)}` });
		// Fields shown for every player need every player.
		expect(player(steve, '?/addField')).toEqual({ status: 403 });
	});

	it('lets an instance admin do everything on its server, and nothing MineShell-wide', async () => {
		const { id } = await server();
		const account = otherUser();
		grant(account.id, id, { admin: true });
		const session = createSession(account.id, null).id;
		const post = (path: string, route: string) => outcome(event(path, { session, method: 'POST', route, params: { id }, headers: ORIGIN }));
		expect(post(`/instances/${id}/settings?/delete`, '/instances/[id]/settings')).toBeNull();
		expect(post(`/instances/${id}/settings?/playitPublic`, '/instances/[id]/settings')).toBeNull();
		// Copying makes a server: that needs "may create servers".
		expect(post(`/instances/${id}/settings?/clone`, '/instances/[id]/settings')).toEqual({ status: 403 });
		expect(post('/settings?/scanJava', '/settings')).toEqual({ status: 403 });
		setAccountFlags(account.id, { canCreate: true });
		expect(post(`/instances/${id}/settings?/clone`, '/instances/[id]/settings')).toBeNull();
	});

	it('lets a global admin manage MineShell, but not the owner-only integrations', async () => {
		const account = otherUser();
		setAccountFlags(account.id, { globalAdmin: true });
		const session = createSession(account.id, null).id;
		const post = (action: string) => outcome(event(`/settings?/${action}`, { session, method: 'POST', route: '/settings', headers: ORIGIN }));
		expect(post('scanJava')).toBeNull();
		expect(post('curseforgeKey')).toEqual({ status: 403 });
		expect(post('playitUnlink')).toEqual({ status: 403 });
		expect(post('update')).toEqual({ status: 403 });
	});
});

describe('an account that must pick its own password', () => {
	it('may only reach its account page and sign out', async () => {
		authControl.enabled = true;
		authControl.setUp = true;
		const { id } = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		const account = otherUser();
		grant(account.id, id, { admin: true });
		db.update(users).set({ mustChangePassword: true }).where(eq(users.id, account.id)).run();
		const session = createSession(account.id, null).id;
		const ORIGIN = { origin: `http://${HOST}` };
		expect(outcome(event(`/instances/${id}`, { session, route: '/instances/[id]', params: { id } }))).toEqual({ redirect: '/account' });
		expect(outcome(event(`/instances/${id}?/power`, { session, method: 'POST', route: '/instances/[id]', params: { id }, headers: ORIGIN }))).toEqual({ status: 403 });
		expect(outcome(event(`/api/instances/${id}/stats`, { session, route: '/api/instances/[id]/stats', params: { id } }))).toEqual({ status: 403 });
		expect(outcome(event('/account', { session }))).toBeNull();
		expect(outcome(event('/account?/password', { session, method: 'POST', headers: ORIGIN }))).toBeNull();
		expect(outcome(event('/login?/logout', { session, method: 'POST', headers: ORIGIN }))).toBeNull();
	});
});
