import { describe, expect, it } from 'vitest';

const { checkDiskSpace } = await import('#lib/server/diskspace.js');
const { removeGlobalTarget, saveGlobalTarget } = await import('#lib/server/notifications.js');
const { saveServerSnapshotOverrides } = await import('#lib/server/snapshots.js');
const { createInstance } = await import('../helpers/instances');
const { useRecordedHttp } = await import('../helpers/http');

const HOOK = 'https://hooks.example/disk';
const sent: Record<string, unknown>[] = [];
useRecordedHttp('none', {
	extra: {
		[HOOK]: async (init) => {
			sent.push(JSON.parse(String(init?.body)));
			return new Response(null, { status: 204 });
		}
	}
});
const settle = () => new Promise((r) => setTimeout(r, 20));

/** The low disk warning (diskspace.ts). The line is set past any real disk, or below any. */
describe('disk space warning', () => {
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
});
