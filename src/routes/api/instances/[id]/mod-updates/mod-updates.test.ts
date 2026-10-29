import { describe, expect, it, vi } from 'vitest';
import { createInstance } from '../../../../../../tests/helpers/instances';
import { call } from '../../../../../../tests/helpers/routes';

/** The update check answers a line per step, so the page can show how far it is. */

const fail = vi.hoisted(() => ({ now: false }));
vi.mock('#lib/server/modupdates.js', () => ({
	checkModUpdates: async (_: unknown, opts: { onProgress: (p: unknown) => void }) => {
		opts.onProgress({ phase: 'check', done: 0, total: 2 });
		opts.onProgress({ phase: 'check', done: 2, total: 2 });
		if (fail.now) throw new Error('Modrinth is down.');
		return { updates: [], upToDate: 2, skipped: [] };
	}
}));

const { GET } = await import('./+server');

async function lines(id: string) {
	const res = await call(GET, { params: { id } });
	return { status: res.status, lines: (await res.text()).trim().split('\n').map((l) => JSON.parse(l)) };
}

describe('GET mod-updates', () => {
	it('sends the progress, then the result', async () => {
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' });
		expect(await lines(instance.id)).toEqual({
			status: 200,
			lines: [
				{ progress: { phase: 'check', done: 0, total: 2 } },
				{ progress: { phase: 'check', done: 2, total: 2 } },
				{ result: { updates: [], upToDate: 2, skipped: [] } }
			]
		});
	});

	it('ends with the message when the check fails', async () => {
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' });
		fail.now = true;
		try {
			expect((await lines(instance.id)).lines.at(-1)).toEqual({ message: 'Modrinth is down.' });
		} finally {
			fail.now = false;
		}
	});

	it('refuses a server that does not exist before checking anything', async () => {
		expect((await call(GET, { params: { id: 'nope' } })).status).toBe(404);
	});
});
