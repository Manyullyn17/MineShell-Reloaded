import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The download writes a stand-in file; no network in tests.
vi.mock('#lib/server/download.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/download.js')>()),
	downloadFile: vi.fn(async (url: string, destination: string) => {
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.writeFile(destination, `zip from ${url}`);
	})
}));

const { DatapackInUseError, installDatapackVersion, listDatapacks, removeDatapack } = await import('#lib/server/mods/datapacks.js');
const { writeNbt } = await import('#lib/server/nbt.js');
const { zipBuffer } = await import('../helpers/fs');
const { createInstance } = await import('../helpers/instances');
const { db } = await import('#lib/server/db/index.js');
const { serverInstances } = await import('#lib/server/db/schema.js');
const { eq } = await import('drizzle-orm');

const PROJECT = { id: 'bxa7yl3z', slug: 'terralith', name: 'Terralith', projectUrl: 'https://modrinth.com/project/terralith', iconUrl: null };

const version = (n: string) => ({
	id: `v-${n}`,
	projectId: PROJECT.id,
	name: n,
	versionNumber: n,
	channel: 'release',
	datePublished: null,
	gameVersions: ['1.21.1'],
	loaders: ['datapack'],
	changelog: null,
	files: [{ filename: `Terralith_1.21_v${n}.zip`, url: `https://cdn.example/${n}.zip`, primary: true, size: 10, hash: { algo: 'sha512' as const, value: `hash-${n}` } }],
	dependencies: []
});

describe('data packs from the mod browser', () => {
	it('installs into the level-name world, even before the world exists, and replaces an older version', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' }, { 'server.properties': 'level-name=survival\n' });
		await installDatapackVersion(instance, 'modrinth', PROJECT, version('2.5.7'));
		expect(await fs.readdir(path.join(instance.path, 'survival', 'datapacks'))).toEqual(['Terralith_1.21_v2.5.7.zip']);

		await installDatapackVersion(instance, 'modrinth', PROJECT, version('2.5.8'));
		const { world, packs } = await listDatapacks(instance);
		expect(world).toBe('survival');
		expect(packs).toEqual([
			expect.objectContaining({ fileName: 'Terralith_1.21_v2.5.8.zip', name: 'Terralith', version: '2.5.8', tracked: true, fromPack: false })
		]);
	});

	it("lists what else is there: the modpack's and hand-added ones, folders included", async () => {
		const instance = await createInstance(
			{ modloader: 'fabric', minecraftVersion: '1.21.1' },
			{
				'world/datapacks/pack-shipped.zip': 'x',
				'world/datapacks/my-tweaks/pack.mcmeta': '{}',
				'world/datapacks/notes.txt': 'not a pack'
			}
		);
		db.update(serverInstances).set({ packDatapacks: JSON.stringify(['pack-shipped.zip']) }).where(eq(serverInstances.id, instance.id)).run();
		const reloaded = db.select().from(serverInstances).where(eq(serverInstances.id, instance.id)).get()!;
		const { packs } = await listDatapacks(reloaded);
		expect(packs.map((p) => [p.fileName, p.fromPack, p.tracked])).toEqual([
			['my-tweaks', false, false],
			['pack-shipped.zip', true, false]
		]);
	});

	it('removes a pack and its record, and refuses anything that is not a plain file name', async () => {
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' });
		await installDatapackVersion(instance, 'modrinth', PROJECT, version('2.5.8'));
		await removeDatapack(instance, 'Terralith_1.21_v2.5.8.zip');
		expect((await listDatapacks(instance)).packs).toEqual([]);
		await expect(removeDatapack(instance, '../server.properties')).rejects.toThrow();
		await expect(removeDatapack(instance, '.')).rejects.toThrow();
	});

	it('refuses to quietly remove a world-generation pack the world has loaded', async () => {
		// level.dat as 1.20.1 writes it: Data.DataPacks.Enabled lists "file/<name>" for each pack loaded.
		const levelDat = writeNbt({
			name: '',
			gzipped: true,
			root: {
				type: 'compound',
				value: [
					[
						'Data',
						{
							type: 'compound',
							value: [
								[
									'DataPacks',
									{
										type: 'compound',
										value: [
											[
												'Enabled',
												{
													type: 'list',
													itemType: 'string',
													value: ['vanilla', 'file/Terralith.zip', 'file/tweaks.zip'].map((value) => ({ type: 'string' as const, value }))
												}
											]
										]
									}
								]
							]
						}
					]
				]
			}
		});
		const instance = await createInstance(
			{ modloader: 'vanilla', minecraftVersion: '1.20.1' },
			{
				'world/level.dat': levelDat,
				'world/datapacks/Terralith.zip': zipBuffer({
					'pack.mcmeta': '{}',
					'data/terralith/worldgen/biome/moonlight_valley.json': '{}'
				}),
				'world/datapacks/tweaks.zip': zipBuffer({ 'pack.mcmeta': '{}', 'data/tweaks/recipes/x.json': '{}' }),
				'world/datapacks/new-biomes.zip': zipBuffer({ 'pack.mcmeta': '{}', 'data/nb/worldgen/biome/x.json': '{}' })
			}
		);
		const { packs } = await listDatapacks(instance);
		expect(packs.map((p) => [p.fileName, p.worldgen, p.loadedByWorld])).toEqual([
			['new-biomes.zip', true, false],
			['Terralith.zip', true, true],
			['tweaks.zip', false, true]
		]);
		await expect(removeDatapack(instance, 'Terralith.zip')).rejects.toThrow(DatapackInUseError);
		// Not loaded yet, or not world generation: removed without a fuss.
		await removeDatapack(instance, 'new-biomes.zip');
		await removeDatapack(instance, 'tweaks.zip');
		await removeDatapack(instance, 'Terralith.zip', { force: true });
		expect((await listDatapacks(instance)).packs).toEqual([]);
	});
});
