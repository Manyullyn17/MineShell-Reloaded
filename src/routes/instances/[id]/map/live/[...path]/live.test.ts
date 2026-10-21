import { describe, expect, it, vi } from 'vitest';

// A map mod listening, without one installed.
vi.mock('#lib/server/worldmap.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/worldmap.js')>()),
	liveMapTarget: async (_: unknown, rel: string, search: string) => `http://127.0.0.1:8123/${rel}${search}`
}));

const { GET } = await import('./+server');
const { useRecordedHttp } = await import('../../../../../../../tests/helpers/http');
const { createInstance } = await import('../../../../../../../tests/helpers/instances');
const { call } = await import('../../../../../../../tests/helpers/routes');

/** The map mod's own web page, passed through behind MineShell's login on MineShell's own address. */

const sent: Headers[] = [];
useRecordedHttp('none', {
	extra: {
		'http://127.0.0.1:8123/up/world': (init) => {
			sent.push(new Headers(init?.headers));
			return new Response('{"players":[]}', {
				headers: { 'content-type': 'application/json', 'set-cookie': 'JSESSIONID=abc; Path=/', 'cache-control': 'no-cache' }
			});
		}
	}
});

describe('the live map proxy', () => {
	it("passes neither MineShell's sign-in to the map nor the map's cookies to MineShell", async () => {
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' });
		const response = await call(GET, {
			params: { id: instance.id, path: 'up/world' },
			url: `http://localhost/instances/${instance.id}/map/live/up/world`,
			headers: { cookie: 'mineshell-session=secret', authorization: 'Basic x', accept: 'application/json' }
		});
		expect(await response.text()).toBe('{"players":[]}');
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(response.headers.get('cache-control')).toBe('no-cache');
		expect(response.headers.get('set-cookie')).toBeNull();
		expect(sent[0].get('cookie')).toBeNull();
		expect(sent[0].get('authorization')).toBeNull();
		expect(sent[0].get('accept')).toBe('application/json');
	});
});
