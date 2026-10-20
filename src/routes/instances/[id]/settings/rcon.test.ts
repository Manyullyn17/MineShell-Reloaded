import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { actions, load } from './+page.server';
import { encryptSecret } from '#lib/server/crypto.js';
import { FULL_ACCESS } from '#lib/shared/access.js';
import { createInstance } from '../../../../../tests/helpers/instances';
import { fakeProcesses, resetProcesses } from '../../../../../tests/helpers/process';
import { post } from '../../../../../tests/helpers/routes';

afterEach(resetProcesses);

describe('the RCON password on the Settings page', () => {
	it('is not sent with the page, in the property values or in the raw file', async () => {
		fakeProcesses(() => ({ stdout: 'ActiveState=inactive\nSubState=dead\n' }));
		const instance = await createInstance(
			{ modloader: 'vanilla', minecraftVersion: '1.21.1', rconPasswordEnc: encryptSecret('hunter2-rcon') },
			{ 'server.properties': 'motd=Hello\nrcon.password=hunter2-rcon\nenable-rcon=true\n' }
		);
		// The owner's view: even full access gets the password only by asking.
		const data = await load({ params: { id: instance.id }, locals: { access: FULL_ACCESS } } as never);
		expect(JSON.stringify(data)).not.toContain('hunter2-rcon');
		expect((data as { properties: { values: Record<string, string> } }).properties.values.motd).toBe('Hello');
	});

	it('is sent when its Show button asks for it', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', rconPasswordEnc: encryptSecret('hunter2-rcon') });
		const result = await (actions.revealRcon as (event: never) => unknown)({ params: { id: instance.id } } as never);
		expect(result).toMatchObject({ ok: true, password: 'hunter2-rcon' });
	});

	it('stays in server.properties when the raw file, which no longer shows it, is saved', async () => {
		const instance = await createInstance(
			{ modloader: 'vanilla', minecraftVersion: '1.21.1', rconPasswordEnc: encryptSecret('hunter2-rcon') },
			{ 'server.properties': 'motd=Hello\nrcon.password=hunter2-rcon\n' }
		);
		await post(actions.propertiesRaw, { params: { id: instance.id }, fields: { raw: 'motd=Changed\n' } });
		const file = await fs.readFile(path.join(instance.path, 'server.properties'), 'utf8');
		expect(file).toContain('motd=Changed');
		expect(file).toContain('rcon.password=hunter2-rcon');
	});
});
