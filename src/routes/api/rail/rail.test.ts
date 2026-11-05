import { beforeEach, describe, expect, it } from 'vitest';
import { NO_ACCESS } from '#lib/shared/access.js';
import { createInstance, systemdStopped } from '../../../../tests/helpers/instances';
import { call } from '../../../../tests/helpers/routes';

const { GET } = await import('./+server');

type Rail = { instances: { id: string; active: string }[] };
const rail = async (access?: typeof NO_ACCESS): Promise<Rail> => (await call(GET, { access, url: 'http://localhost/api/rail' })).json();

/** The sidebar reads this by itself, to stay current on pages that do not reload their data. */
describe('the rail', () => {
	beforeEach(() => systemdStopped());

	it('gives each server with its state, as the page data does', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		expect((await rail()).instances).toContainEqual(expect.objectContaining({ id: instance.id, active: 'inactive' }));
	});

	it('leaves out servers the account may not see', async () => {
		const seen = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		const hidden = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		const access = { ...NO_ACCESS, instances: { [seen.id]: { admin: false, permissions: ['view'] } } } as unknown as typeof NO_ACCESS;
		const ids = (await rail(access)).instances.map((s) => s.id);
		expect(ids).toContain(seen.id);
		expect(ids).not.toContain(hidden.id);
	});
});
