import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const page = await import('./+page.server');
const { createInstance, systemdStopped } = await import('../../../../../tests/helpers/instances');
const { load, post } = await import('../../../../../tests/helpers/routes');
const { zipBuffer } = await import('../../../../../tests/helpers/fs');

/**
 * The Data packs tab beside the world's own: the folders a data pack loader on the server reads
 * for every world, listed, uploaded into and removed from. Only folders it lists are taken.
 */

const jar = (id: string) => zipBuffer({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id, name: id }) });
const pack = zipBuffer({ 'pack.mcmeta': '{}' });

async function server(mods: Record<string, Buffer>) {
	systemdStopped();
	const files = Object.fromEntries(Object.entries(mods).map(([name, b]) => [`mods/${name}`, b]));
	const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' }, files);
	return { instance, params: { id: instance.id } };
}
const zip = (name: string) => new File([new Uint8Array(pack)], name);

describe("the Data packs tab and data pack loaders' folders", () => {
	it("lists the folders each loader's build reads, with their packs", async () => {
		const { instance, params } = await server({ 'OpenLoader-fabric-1.21.1-21.1.4.jar': jar('openloader'), 'paxi-1.21-1.0.jar': jar('paxi'), 'kubejs-fabric-2101.jar': jar('kubejs') });
		await fs.mkdir(path.join(instance.path, 'config/paxi/datapacks/folder-pack'), { recursive: true });
		await fs.writeFile(path.join(instance.path, 'config/paxi/datapacks/mine.zip'), pack);
		await fs.writeFile(path.join(instance.path, 'config/paxi/datapacks/notes.txt'), 'not a pack');
		const { loaderDatapacks } = await load(page, { params });
		// Open Loader 21 reads packs/ and the server's datapacks/; KubeJS's folder holds no packs.
		expect(loaderDatapacks).toEqual([
			{ mod: 'Open Loader', folder: 'config/openloader/packs', packs: [] },
			{ mod: 'Open Loader', folder: 'datapacks', packs: [] },
			{
				mod: 'Paxi',
				folder: 'config/paxi/datapacks',
				packs: [
					{ fileName: 'folder-pack', path: 'config/paxi/datapacks/folder-pack', sizeBytes: 0, worldgen: false },
					{ fileName: 'mine.zip', path: 'config/paxi/datapacks/mine.zip', sizeBytes: pack.length, worldgen: false }
				]
			}
		]);
	});

	it("uploads zips into the world's datapacks/ or a folder a loader reads, and no other", async () => {
		const { instance, params } = await server({ 'paxi-1.21-1.0.jar': jar('paxi') });
		expect(await post(page.actions.uploadDatapacks, { params, fields: { datapacks: zip('a.zip') } })).toMatchObject({ ok: true, message: expect.stringContaining('to world/datapacks/') });
		expect(await post(page.actions.uploadDatapacks, { params, fields: { datapacks: [zip('b.zip'), new File(['x'], 'notes.txt')], folder: 'config/paxi/datapacks' } })).toMatchObject({
			ok: true,
			message: expect.stringContaining('to config/paxi/datapacks/ (1 not a .zip, skipped)')
		});
		expect(await post(page.actions.uploadDatapacks, { params, fields: { datapacks: zip('c.zip'), folder: 'config' } })).toMatchObject({ status: 400 });
		expect(await post(page.actions.uploadDatapacks, { params, fields: { datapacks: zip('c.zip'), folder: 'config/openloader/packs' } })).toMatchObject({ status: 400 });
		expect(await fs.readdir(path.join(instance.path, 'world/datapacks'))).toEqual(['a.zip']);
		expect(await fs.readdir(path.join(instance.path, 'config/paxi/datapacks'))).toEqual(['b.zip']);
		expect(await fs.readdir(path.join(instance.path, 'config'))).toEqual(['paxi']);
	});

	it('removes a pack from a loader folder only when that folder lists it', async () => {
		const { instance, params } = await server({ 'paxi-1.21-1.0.jar': jar('paxi') });
		await fs.mkdir(path.join(instance.path, 'config/paxi/datapacks'), { recursive: true });
		await fs.writeFile(path.join(instance.path, 'config/paxi/datapacks/mine.zip'), pack);
		await fs.writeFile(path.join(instance.path, 'config/keep.zip'), pack);
		expect(await post(page.actions.removeDatapack, { params, fields: { fileName: 'keep.zip', folder: 'config' } })).toMatchObject({ status: 400 });
		expect(await post(page.actions.removeDatapack, { params, fields: { fileName: '../keep.zip', folder: 'config/paxi/datapacks' } })).toMatchObject({ status: 400 });
		expect(await post(page.actions.removeDatapack, { params, fields: { fileName: 'mine.zip', folder: 'config/paxi/datapacks' } })).toMatchObject({ ok: true });
		expect(await fs.readdir(path.join(instance.path, 'config/paxi/datapacks'))).toEqual([]);
		expect(await fs.readdir(path.join(instance.path, 'config'))).toContain('keep.zip');
	});
});
