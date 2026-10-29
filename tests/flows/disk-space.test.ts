import { beforeEach, describe, expect, it } from 'vitest';

const { checkDiskSpace, resetDiskSpace } = await import('#lib/server/diskspace.js');
const { removeGlobalTarget, saveGlobalTarget, saveServerTarget } = await import('#lib/server/notifications.js');
const { saveServerSnapshotOverrides } = await import('#lib/server/snapshots.js');
const { createInstance } = await import('../helpers/instances');
const { useRecordedHttp } = await import('../helpers/http');

const HOOK = 'https://hooks.example/disk';
const OWN_HOOK = 'https://hooks.example/own';
const sent: Record<string, unknown>[] = [];
const ownSent: Record<string, unknown>[] = [];
useRecordedHttp('none', {
	extra: {
		[HOOK]: async (init) => {
			sent.push(JSON.parse(String(init?.body)));
			return new Response(null, { status: 204 });
		},
		[OWN_HOOK]: async (init) => {
			ownSent.push(JSON.parse(String(init?.body)));
			return new Response(null, { status: 204 });
		}
	}
});
const settle = () => new Promise((r) => setTimeout(r, 20));

/** The low disk warning (diskspace.ts). The line is set past any real disk, or below any. */
describe('disk space warning', () => {
	beforeEach(() => resetDiskSpace());

	it('sends one message per disk when it drops below the line, and again only after it was above', async () => {
		const a = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', name: 'Alpha' });
		const b = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', name: 'Beta' });
		saveGlobalTarget({ type: 'webhook', url: HOOK, kinds: ['disk'] });
		sent.length = 0;
		try {
			// The largest "keep free" of the servers on the disk is its line.
			saveServerSnapshotOverrides(b.id, { minFreeMb: 100 * 1024 * 1024 });
			await checkDiskSpace([a, b]);
			await checkDiskSpace([a, b]);
			await settle();
			expect(sent).toEqual([expect.objectContaining({ event: 'disk', title: 'Disk running low', message: expect.stringMatching(/this server and Beta/) })]);

			saveServerSnapshotOverrides(b.id, { minFreeMb: 1 });
			saveServerSnapshotOverrides(a.id, { minFreeMb: 1 });
			await checkDiskSpace([a, b]);
			saveServerSnapshotOverrides(a.id, { minFreeMb: 100 * 1024 * 1024 });
			await checkDiskSpace([a, b]);
			await settle();
			expect(sent).toHaveLength(2);
		} finally {
			removeGlobalTarget();
		}
	});

	it('reaches every destination the servers on the disk use, each once', async () => {
		const a = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', name: 'Alpha' });
		const b = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', name: 'Beta' });
		const c = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', name: 'Gamma' });
		saveGlobalTarget({ type: 'webhook', url: HOOK, kinds: ['disk'] });
		// Beta sends only to its own destination; Alpha and Gamma to the global one.
		saveServerTarget(b.id, { type: 'webhook', url: OWN_HOOK, kinds: ['disk'], alsoGlobal: false });
		sent.length = 0;
		ownSent.length = 0;
		try {
			saveServerSnapshotOverrides(a.id, { minFreeMb: 100 * 1024 * 1024 });
			await checkDiskSpace([a, b, c]);
			await settle();
			expect(sent).toEqual([expect.objectContaining({ event: 'disk', message: expect.stringMatching(/this server and Beta, Gamma/) })]);
			expect(ownSent).toEqual([expect.objectContaining({ event: 'disk', message: expect.stringMatching(/this server and Alpha, Gamma/) })]);
		} finally {
			removeGlobalTarget();
		}
	});
});
