import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { langKeysFor, legacyEnchantmentTable, nameFromId, readEnchantmentRegistry } from './enchantnames';
import { writeNbt, type Tag } from './nbt';
import { tempDir, writeJar } from '../../../tests/helpers/fs';

const compound = (entries: [string, Tag][]): Tag => ({ type: 'compound', value: entries });

/** A 1.12 level.dat as Forge writes it: FML > Registries > minecraft:enchantments > ids. */
async function world(dir: string, ids: [string, number][] | null) {
	const data: [string, Tag][] = [['LevelName', { type: 'string', value: 'world' }]];
	const fml = ids
		? compound([
				[
					'Registries',
					compound([
						[
							'minecraft:enchantments',
							compound([
								[
									'ids',
									{
										type: 'list',
										itemType: 'compound',
										value: ids.map(([k, v]) => compound([['K', { type: 'string', value: k }], ['V', { type: 'int', value: v }]]))
									}
								]
							])
						]
					])
				]
			])
		: null;
	const root = compound([['Data', compound(data)], ...(fml ? [['FML', fml] as [string, Tag]] : [])]);
	await fs.mkdir(path.join(dir, 'world'), { recursive: true });
	await fs.writeFile(path.join(dir, 'world', 'level.dat'), writeNbt({ name: '', root: root as Extract<Tag, { type: 'compound' }>, gzipped: true }));
	return path.join(dir, 'world');
}

describe('enchantment names on 1.12', () => {
	it("reads the world's own number table from level.dat", async () => {
		const dir = await tempDir();
		const w = await world(dir, [
			['minecraft:sharpness', 16],
			['cofhcore:soulbound', 97]
		]);
		expect(await readEnchantmentRegistry(w)).toEqual(
			new Map([
				[16, 'minecraft:sharpness'],
				[97, 'cofhcore:soulbound']
			])
		);
	});

	it('names mod enchantments from their lang files, vanilla from its own list, the rest from the id', async () => {
		const dir = await tempDir();
		const w = await world(dir, [
			['minecraft:sharpness', 16],
			['minecraft:sweeping', 22],
			['cofhcore:soulbound', 97],
			['xu2:xu.kaboomerang', 98],
			['openblocks:last_stand', 99]
		]);
		await writeJar(path.join(dir, 'mods'), 'CoFHCore.jar', { 'assets/cofhcore/lang/en_us.lang': 'enchantment.cofhcore.soulbound=Soulbound\nitem.x.name=X\n' });
		// A disabled jar still names its enchantments: the world may hold them.
		await writeJar(path.join(dir, 'mods'), 'xu2.jar.disabled', { 'assets/xu2/lang/en_US.lang': 'enchantment.xu.kaboomerang=Kaboomerang\n' });
		expect(await legacyEnchantmentTable(dir, w)).toEqual({
			16: { id: 'minecraft:sharpness', name: 'Sharpness' },
			22: { id: 'minecraft:sweeping', name: 'Sweeping Edge' },
			97: { id: 'cofhcore:soulbound', name: 'Soulbound' },
			98: { id: 'xu2:xu.kaboomerang', name: 'Kaboomerang' },
			99: { id: 'openblocks:last_stand', name: 'Last Stand' }
		});
	});

	it("falls back to vanilla's fixed numbers when the world has no table", async () => {
		const dir = await tempDir();
		const table = await legacyEnchantmentTable(dir, await world(dir, null));
		expect(table[70]).toEqual({ id: 'minecraft:mending', name: 'Mending' });
		expect(table[10]).toEqual({ id: 'minecraft:binding_curse', name: 'Curse of Binding' });
	});

	it('makes a readable name from awkward ids', () => {
		expect(nameFromId('draconicevolution:enchant_reaper')).toBe('Reaper');
		expect(nameFromId('cyclicmagic:enchantment.autosmelt')).toBe('Autosmelt');
		expect(nameFromId('openblocks:last_stand')).toBe('Last Stand');
		expect(nameFromId('mod:flimFlam')).toBe('Flim Flam');
		expect(langKeysFor('xu2:xu.kaboomerang')).toContain('enchantment.xu.kaboomerang');
	});
});
