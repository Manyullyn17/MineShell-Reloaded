import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as page from './+page.server';
import { actions } from './+page.server';
import type { Access, InstancePermission } from '#lib/shared/access.js';
import { readProperties } from '#lib/server/properties.js';
import { createInstance, reload, systemdStopped } from '../../../../../tests/helpers/instances';
import { resetProcesses } from '../../../../../tests/helpers/process';
import { load, post } from '../../../../../tests/helpers/routes';

afterEach(resetProcesses);

/**
 * server.properties keys that reach past "Change settings": Minecraft's
 * management server (1.21.9+) manages operators, bans and the whitelist over
 * a port of its own, and level-name is a folder path the game follows
 * anywhere, another server's world included.
 */

const as = (id: string, ...permissions: InstancePermission[]): Access => ({
	owner: false,
	globalAdmin: false,
	canCreate: false,
	instances: { [id]: { admin: false, permissions: ['settings.view', ...permissions], playerView: 'none', playerEdit: 'none' } }
});

const PROPERTIES = ['motd=Hello', 'level-name=world', 'management-server-enabled=false', 'management-server-port=25585', 'management-server-secret=s3cret-token', ''].join('\n');

async function server() {
	systemdStopped();
	return createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.10' }, { 'server.properties': PROPERTIES });
}

const file = async (dir: string) => (await readProperties(dir)).values;

describe("Minecraft's management server settings", () => {
	it('are changed only with "Loader, modpack and Java", through either editor', async () => {
		const instance = await server();
		const params = { id: instance.id };
		const editor = as(instance.id, 'settings.edit');
		const refused = { status: 400, data: { message: expect.stringContaining('management-server') } };

		expect(await post(actions.properties, { params, access: editor, fields: { 'extra:management-server-enabled': 'true' } })).toMatchObject(refused);
		expect(
			await post(actions.propertiesRaw, { params, access: editor, fields: { raw: 'motd=Hello\nlevel-name=world\nmanagement-server-enabled=true\nmanagement-server-port=25585\n' } })
		).toMatchObject(refused);
		expect(await post(actions.propertiesRaw, { params, access: editor, fields: { raw: 'motd=Hello\nlevel-name=world\n' } })).toMatchObject(refused);
		expect(await file(instance.path)).toMatchObject({ 'management-server-enabled': 'false', 'management-server-secret': 's3cret-token' });

		const software = as(instance.id, 'settings.edit', 'software');
		expect(await post(actions.properties, { params, access: software, fields: { 'extra:management-server-enabled': 'true' } })).toMatchObject({ ok: true });
		expect((await file(instance.path))['management-server-enabled']).toBe('true');
	});

	it("hide the secret from accounts that may not change them, and keep it when they save other settings", async () => {
		const instance = await server();
		const params = { id: instance.id };
		const viewer = as(instance.id, 'settings.edit');
		const shown = (await load(page, { params, access: viewer })).properties as { values: Record<string, string>; extras: { key: string }[]; raw: string };
		expect(shown.values).not.toHaveProperty(['management-server-secret']);
		expect(shown.extras.map((e) => e.key)).not.toContain('management-server-secret');
		expect(shown.raw).not.toContain('s3cret-token');

		// Saving what the page showed, with one change, keeps the secret it left out.
		expect(await post(actions.propertiesRaw, { params, access: viewer, fields: { raw: shown.raw.replace('motd=Hello', 'motd=Changed') } })).toMatchObject({ ok: true });
		expect(await file(instance.path)).toMatchObject({ motd: 'Changed', 'management-server-secret': 's3cret-token' });
		expect(await post(actions.properties, { params, access: viewer, fields: { motd: 'Again' } })).toMatchObject({ ok: true });
		expect(await file(instance.path)).toMatchObject({ motd: 'Again', 'management-server-secret': 's3cret-token' });

		const software = (await load(page, { params, access: as(instance.id, 'software') })).properties as { raw: string };
		expect(software.raw).toContain('management-server-secret=s3cret-token');
	});
});

describe('the world folder (level-name)', () => {
	it('stays inside the server folder', async () => {
		const instance = await server();
		const params = { id: instance.id };
		const refused = { status: 400, data: { message: 'The world folder (level-name) has to be inside the server folder.' } };
		const elsewhere = ['../other-server/world', '/home/someone/world', 'worlds/../../x', '', '  '];
		for (const levelName of elsewhere) {
			expect(await post(actions.properties, { params, fields: { 'level-name': levelName } }), levelName).toMatchObject(refused);
			expect(await post(actions.propertiesRaw, { params, fields: { raw: `motd=Hello\nlevel-name=${levelName}\n` } }), levelName).toMatchObject(refused);
		}
		expect((await file(instance.path))['level-name']).toBe('world');

		expect(await post(actions.properties, { params, fields: { 'level-name': 'worlds/main' } })).toMatchObject({ ok: true });
		expect((await file(instance.path))['level-name']).toBe('worlds/main');
	});

	it('already outside it does not stop other settings being saved', async () => {
		const instance = await server();
		await fs.writeFile(path.join(instance.path, 'server.properties'), 'motd=Hello\nlevel-name=../elsewhere\n');
		expect(await post(actions.properties, { params: { id: instance.id }, fields: { motd: 'Changed' } })).toMatchObject({ ok: true });
	});
});

describe('the game port in the raw editor', () => {
	it('is a port, or the file is not written', async () => {
		const instance = await server();
		for (const port of ['0', '70000', 'abc', '25565.5']) {
			const raw = `motd=Changed\nlevel-name=world\nserver-port=${port}\n`;
			expect(await post(actions.propertiesRaw, { params: { id: instance.id }, fields: { raw } }), port).toMatchObject({
				status: 400,
				data: { message: 'The game port (server-port) goes from 1 to 65535.' }
			});
		}
		expect(reload(instance.id).serverPort).toBe(instance.serverPort);
		expect((await file(instance.path)).motd).toBe('Hello');
	});
});

describe('settings that changed form between Minecraft versions', () => {
	type Shown = { values: Record<string, string>; schema: { key: string; options?: { value: string }[] }[]; gameRules: string[] | null };
	const shown = async (id: string) => (await load(page, { params: { id } })).properties as Shown;

	it('shows and saves difficulty and game mode as numbers before 1.14, which reads no names', async () => {
		systemdStopped();
		const instance = await createInstance({ modloader: 'forge', minecraftVersion: '1.12.2' }, { 'server.properties': 'difficulty=normal\ngamemode=1\nlevel-name=world\n' });
		const before = await shown(instance.id);
		expect(before.values).toMatchObject({ difficulty: '2', gamemode: '1' });
		expect(before.schema.find((f) => f.key === 'difficulty')?.options?.map((o) => o.value)).toEqual(['0', '1', '2', '3']);

		// Saving any section puts a name left in the file right too.
		expect(await post(actions.properties, { params: { id: instance.id }, fields: { motd: 'Changed' } })).toMatchObject({ ok: true });
		expect(await file(instance.path)).toMatchObject({ difficulty: '2', gamemode: '1', motd: 'Changed' });
		expect(await post(actions.properties, { params: { id: instance.id }, fields: { difficulty: '3' } })).toMatchObject({ ok: true });
		expect((await file(instance.path)).difficulty).toBe('3');
	});

	it('leaves out PvP, the Nether, monsters and command blocks from 1.21.9, and names the game rules instead', async () => {
		systemdStopped();
		const props = 'pvp=false\nspawn-monsters=true\nlevel-name=world\ndifficulty=2\n';
		const newer = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.11' }, { 'server.properties': props });
		const after = await shown(newer.id);
		expect(after.schema.map((f) => f.key)).not.toContain('pvp');
		expect(after.gameRules).toEqual(['pvp', 'spawn_monsters', 'allow_entering_nether_using_portals', 'command_blocks_work']);
		expect(after.values.difficulty).toBe('normal');

		const older = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.8' }, { 'server.properties': props });
		const before = await shown(older.id);
		expect(before.schema.map((f) => f.key)).toContain('pvp');
		expect(before.gameRules).toBeNull();
	});
});
