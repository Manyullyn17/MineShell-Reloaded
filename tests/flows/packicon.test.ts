import { describe, expect, it } from 'vitest';

const { markPackIconTried, packIconPending } = await import('#lib/server/packicon.js');
const { createInstance } = await import('../helpers/instances');

const pack = { modloader: 'fabric', minecraftVersion: '1.20.1', packSource: 'modrinth', packProjectId: 'abc' };

describe('the pack icon as server icon', () => {
	it('is put on a pack server without an icon, once', async () => {
		const s = await createInstance(pack);
		expect(await packIconPending(s)).toBe(true);
		// Tried (applied, failed, or the icon removed/replaced since): never again.
		markPackIconTried(s.id);
		expect(await packIconPending(s)).toBe(false);
	});

	it('leaves alone servers with an icon, without a provider pack, or still installing', async () => {
		expect(await packIconPending(await createInstance(pack, { 'server-icon.png': 'png' }))).toBe(false);
		expect(await packIconPending(await createInstance({ ...pack, packSource: null, packProjectId: null }))).toBe(false);
		expect(await packIconPending(await createInstance({ ...pack, packSource: 'manual' }))).toBe(false);
		expect(await packIconPending(await createInstance({ ...pack, status: 'provisioning' }))).toBe(false);
	});
});
