import { describe, expect, it, vi } from 'vitest';
import { call } from '../../../../../../tests/helpers/routes';
import { createInstance } from '../../../../../../tests/helpers/instances';

// What the pack's host answers for its icon: anything it likes.
const answer = vi.hoisted(() => ({ type: 'image/png' }));
vi.mock('#lib/server/packicon.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/packicon.js')>()),
	packIconUrl: async () => 'https://cdn.example/icon'
}));
vi.mock('#lib/server/outbound.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/outbound.js')>()),
	outboundFetch: async () => new Response('<script>alert(document.cookie)</script>', { headers: { 'content-type': answer.type } })
}));

const { GET } = await import('./+server');

/**
 * The pack's icon is passed on from wherever the pack's platform says it is.
 * Its type, as that host sent it, would make text/html (or a scripted SVG) a
 * page on MineShell's own origin: only image types go through.
 */
describe("a pack's icon", () => {
	it('is passed on as an image only when it is one', async () => {
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' });
		const get = () => call(GET, { params: { id: instance.id }, url: `http://localhost/api/instances/${instance.id}/icon?source=pack` });

		expect((await get()).headers.get('content-type')).toBe('image/png');
		for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml']) {
			answer.type = type;
			const res = await get();
			expect(res.headers.get('content-type'), type).toBe('application/octet-stream');
			expect(res.headers.get('content-security-policy')).toContain('sandbox');
		}
	});
});
