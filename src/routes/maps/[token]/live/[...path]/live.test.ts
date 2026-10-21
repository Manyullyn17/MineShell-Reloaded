import { describe, expect, it, vi } from 'vitest';

// A map mod listening, without one installed.
vi.mock('#lib/server/worldmap.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/worldmap.js')>()),
	liveMapTarget: async (_: unknown, rel: string, search: string) => `http://127.0.0.1:8123/${rel}${search}`
}));

const { GET, OPTIONS, POST } = await import('./+server');
const { mapToken } = await import('#lib/server/mapframe.js');
const { createSession } = await import('#lib/server/auth.js');
const { grant, otherUser } = await import('../../../../../../tests/helpers/auth');
const { useRecordedHttp } = await import('../../../../../../tests/helpers/http');
const { createInstance } = await import('../../../../../../tests/helpers/instances');
const { call } = await import('../../../../../../tests/helpers/routes');

/** A map mod's own web page, passed through sandboxed under the Map tab's token (mapframe.ts). */

const sent: Headers[] = [];
useRecordedHttp('none', {
	extra: {
		'http://127.0.0.1:8123/up/world': (init?: RequestInit) => {
			sent.push(new Headers(init?.headers));
			return new Response('{"players":[]}', {
				headers: { 'content-type': 'application/json', 'set-cookie': 'JSESSIONID=abc; Path=/', 'cache-control': 'no-cache', 'access-control-allow-origin': 'https://evil.example' }
			});
		},
		'http://127.0.0.1:8123/': () => new Response('<html><head><title>Dynmap</title></head><body></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
		'http://127.0.0.1:8123/up/sendmessage': () => Response.json({ error: 'none' })
	}
});

async function setup() {
	const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' });
	const token = mapToken(null, instance.id);
	const at = (rel: string) => ({ params: { token, path: rel }, url: `http://localhost/maps/${token}/live/${rel}` });
	return { instance, token, at };
}

describe('the live map proxy', () => {
	it("passes neither MineShell's sign-in to the map nor the map's cookies and headers to the browser", async () => {
		const { at } = await setup();
		const response = await call(GET, { ...at('up/world'), headers: { cookie: 'mineshell-session=secret', authorization: 'Basic x', accept: 'application/json' } });
		expect(await response.text()).toBe('{"players":[]}');
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(response.headers.get('cache-control')).toBe('no-cache');
		expect(response.headers.get('set-cookie')).toBeNull();
		expect(response.headers.get('access-control-allow-origin')).toBe('*');
		expect(sent[0].get('cookie')).toBeNull();
		expect(sent[0].get('authorization')).toBeNull();
		expect(sent[0].get('accept')).toBe('application/json');
	});

	it('serves its pages sandboxed, with the storage shim first', async () => {
		const { at } = await setup();
		const response = await call(GET, at(''));
		expect(response.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts /);
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(await response.text()).toMatch(/^<html><head><script>\(\(\) => \{[\s\S]*<title>Dynmap<\/title>/);
	});

	it('answers the preflights of Dynmap\'s requests; its web chat needs map.render to post', async () => {
		const { at } = await setup();
		// Dynmap's jQuery takes the sandboxed page for its own address and adds X-Requested-With to every request.
		const preflight = await call(OPTIONS, { ...at('up/sendmessage'), method: 'OPTIONS', headers: { 'access-control-request-headers': 'content-type,x-requested-with' } });
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type,x-requested-with');
		expect((await call(POST, { ...at('up/sendmessage'), method: 'POST', json: { message: 'hi' } })).status).toBe(200);
	});

	it("refuses the web chat to an account that may only look", async () => {
		const { instance } = await setup();
		const viewer = otherUser();
		grant(viewer.id, instance.id, { permissions: ['view'] });
		const token = mapToken(createSession(viewer.id, null).id, instance.id);
		const at = (rel: string) => ({ params: { token, path: rel }, url: `http://localhost/maps/${token}/live/${rel}` });
		expect((await call(GET, at('up/world'))).status).toBe(200);
		expect((await call(POST, { ...at('up/sendmessage'), method: 'POST', json: { message: 'hi' } })).status).toBe(403);
	});

	it('refuses a token it does not know', async () => {
		const { instance } = await setup();
		const token = 'A'.repeat(43);
		const response = await call(GET, { params: { token, path: 'up/world' }, url: `http://localhost/maps/${token}/live/up/world` });
		expect(response.status).toBe(403);
		expect(instance).toBeDefined();
	});
});
