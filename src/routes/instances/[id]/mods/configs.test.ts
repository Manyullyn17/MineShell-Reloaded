import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Access } from '#lib/shared/access.js';

const page = await import('./+page.server');
const { createInstance, systemdStopped } = await import('../../../../../tests/helpers/instances');
const { load } = await import('../../../../../tests/helpers/routes');
const { zipBuffer } = await import('../../../../../tests/helpers/fs');

/** The Mods tab's config files per mod: what opens them in Files, for those who may use Files. */

const jar = (id: string, name: string) => zipBuffer({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id, name }) });

async function server() {
	systemdStopped();
	const instance = await createInstance(
		{ modloader: 'fabric', minecraftVersion: '1.21.1' },
		{ 'mods/sodium.jar': jar('sodium', 'Sodium'), 'mods/lithium.jar': jar('lithium', 'Lithium'), 'config/sodium-options.json': '{}', 'config/lithium.properties': '' }
	);
	await fs.mkdir(path.join(instance.path, 'config/sodium'), { recursive: true });
	await fs.writeFile(path.join(instance.path, 'config/sodium/extra.toml'), 'a = 1\n');
	return { instance, params: { id: instance.id } };
}

describe('config files on the Mods tab', () => {
	it('lists each mod’s config files', async () => {
		const { params } = await server();
		const { configs } = await load(page, { params });
		expect(await configs).toEqual({ 'lithium.jar': ['config/lithium.properties'], 'sodium.jar': ['config/sodium/extra.toml', 'config/sodium-options.json'] });
	});

	it('lists none for an account that may not use Files', async () => {
		const { instance, params } = await server();
		const modsOnly: Access = {
			owner: false,
			globalAdmin: false,
			canCreate: false,
			instances: { [instance.id]: { admin: false, permissions: ['mods'], playerView: 'none', playerEdit: 'none' } }
		};
		const { configs } = await load(page, { params, access: modsOnly });
		expect(await configs).toEqual({});
	});
});
