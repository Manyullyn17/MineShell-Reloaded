import { describe, expect, it } from 'vitest';

const page = await import('./+page.server');
const { fingerprintOf, saveModNotice, skipModNotice } = await import('#lib/server/modnotice.js');
const { createInstance, systemdStopped } = await import('../../../../../tests/helpers/instances');
const { load } = await import('../../../../../tests/helpers/routes');

/** Updates the scheduled check or Check now found: the Updates tab only lists a check of its own. */

const known = async (id: string) => (await load(page, { params: { id } })).modUpdatesKnown;

describe("the Mods page's Updates tab", () => {
	it('checks when opened once the update check has found mod updates', async () => {
		systemdStopped();
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1', updateCheck: true, modUpdateCheck: true });
		expect(await known(instance.id)).toBe(false);
		saveModNotice(instance.id, [{ fileName: 'lithium.jar', name: 'Lithium', from: '0.21.1', to: '0.21.4' }]);
		expect(await known(instance.id)).toBe(true);
	});

	it('does not for updates skipped, or with mod checks off', async () => {
		systemdStopped();
		const skipped = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1', updateCheck: true, modUpdateCheck: true });
		const updates = [{ fileName: 'lithium.jar', name: 'Lithium', from: '0.21.1', to: '0.21.4' }];
		saveModNotice(skipped.id, updates);
		skipModNotice(skipped.id, fingerprintOf(updates));
		expect(await known(skipped.id)).toBe(false);
		const off = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1', updateCheck: true, modUpdateCheck: false });
		saveModNotice(off.id, [{ fileName: 'lithium.jar', name: 'Lithium', from: '0.21.1', to: '0.21.4' }]);
		expect(await known(off.id)).toBe(false);
	});
});
