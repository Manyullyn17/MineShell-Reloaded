import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Item icons (itemicons.ts): models and textures read from jars the way the
 * game reads them. The jars are built here, small; the logic is real.
 */

const { Resources, resolveIcon, variantModels, iconsFor, iconTexture, itemChoices, itemName, CLIENT_DIR } = await import('#lib/server/itemicons.js');
const { writeNbt } = await import('#lib/server/nbt.js');
const { saveMapSettings } = await import('#lib/server/worldmap.js');
const { createInstance } = await import('../helpers/instances');
const { zipBuffer } = await import('../helpers/fs');

const json = (v: unknown) => JSON.stringify(v);
const PNG = Buffer.from('png');

/** Writes a jar of `files` and returns its path. */
async function jar(name: string, files: Record<string, string | Buffer>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.env.MINESHELL_DATA!, 'jars-'));
	const file = path.join(dir, name);
	await fs.writeFile(file, zipBuffer(files));
	return file;
}

/** A small "client jar": generated items, a full block, a slab, an entity-drawn chest. */
const vanilla = () =>
	jar('client.jar', {
		'assets/minecraft/models/item/generated.json': json({ parent: 'builtin/generated' }),
		'assets/minecraft/models/item/diamond.json': json({ parent: 'item/generated', textures: { layer0: 'items/diamond' } }),
		'assets/minecraft/models/block/cube.json': json({
			elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#up', tintindex: 0 }, north: { texture: '#north' }, east: { texture: '#east' }, west: { texture: '#west' } } }]
		}),
		'assets/minecraft/models/block/cube_all.json': json({ parent: 'block/cube', textures: { up: '#all', north: '#all', east: '#all', west: '#all' } }),
		'assets/minecraft/models/block/red_wool.json': json({ parent: 'block/cube_all', textures: { all: 'blocks/wool_colored_red' } }),
		'assets/minecraft/models/item/red_wool.json': json({ parent: 'block/red_wool' }),
		'assets/minecraft/models/item/dye_blue.json': json({ parent: 'item/generated', textures: { layer0: 'items/dye_powder_blue' } }),
		'assets/minecraft/models/item/diamond_pickaxe.json': json({ parent: 'item/generated', textures: { layer0: 'items/diamond_pickaxe' } }),
		'assets/minecraft/models/item/chest.json': json({ parent: 'builtin/entity' }),
		'assets/minecraft/models/block/stairs.json': json({
			display: { gui: { rotation: [30, 135, 0], scale: [0.625, 0.625, 0.625] } },
			elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { up: { texture: '#top' } } }]
		}),
		'assets/minecraft/models/block/oak_stairs.json': json({ parent: 'block/stairs', textures: { top: 'blocks/planks_oak' } }),
		'assets/minecraft/models/item/oak_stairs.json': json({ parent: 'block/oak_stairs' }),
		'assets/minecraft/textures/items/diamond.png': PNG
	});

describe('item icons', () => {
	it('reads 1.12-style models: flat items, blocks with their faces, nothing for what the game draws in code', async () => {
		const res = await Resources.load([], await vanilla());
		expect(await resolveIcon(res, 'minecraft:diamond')).toEqual({ spec: { kind: 'flat', layers: [{ texture: 'minecraft:items/diamond', tint: null }] }, exact: true, variant: false });
		const wool = await resolveIcon(res, 'minecraft:wool', 14);
		expect(wool).toMatchObject({ exact: true, spec: { kind: 'block' } });
		const faces = (wool.spec as { elements: { faces: Record<string, { texture: string; uv: number[] }> }[] }).elements[0].faces;
		// Every side but the bottom: which show depends on the view's rotation.
		expect(Object.keys(faces).sort()).toEqual(['east', 'north', 'up', 'west']);
		expect(wool.spec).toMatchObject({ rotation: [30, 225, 0] });
		// Stairs turn their own way in the inventory (block/stairs.json says 135), inherited by every stair.
		expect(await resolveIcon(res, 'minecraft:oak_stairs')).toMatchObject({ spec: { kind: 'block', rotation: [30, 135, 0] } });
		expect(faces.up).toMatchObject({ texture: 'minecraft:blocks/wool_colored_red', uv: [0, 0, 16, 16] });
		// Dye's damage picks a variant (the tooltip says so); a tool's is wear.
		expect(await resolveIcon(res, 'minecraft:dye', 4)).toMatchObject({ spec: { layers: [{ texture: 'minecraft:items/dye_powder_blue' }] }, exact: true, variant: true });
		expect(await resolveIcon(res, 'minecraft:diamond_pickaxe', 120)).toMatchObject({ spec: { kind: 'flat' }, exact: true, variant: false });
		expect(await resolveIcon(res, 'minecraft:chest')).toMatchObject({ spec: null, exact: true });
		expect(await resolveIcon(res, 'minecraft:nothing')).toEqual({ spec: null, exact: true });
	});

	it('reads 1.21.4 item definitions with their tints', async () => {
		const res = await Resources.load(
			[
				await jar('modern.jar', {
					'assets/minecraft/items/oak_leaves.json': json({ model: { type: 'minecraft:model', model: 'minecraft:block/oak_leaves', tints: [{ type: 'minecraft:constant', value: -12012264 }] } }),
					'assets/minecraft/models/block/oak_leaves.json': json({ parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/oak_leaves' } }),
					'assets/minecraft/items/chest.json': json({ model: { type: 'minecraft:select', cases: [], fallback: { type: 'minecraft:special', base: 'minecraft:item/chest' } } })
				})
			],
			await vanilla()
		);
		const leaves = await resolveIcon(res, 'minecraft:oak_leaves');
		expect((leaves.spec as { elements: { faces: { up: { tint: string } } }[] }).elements[0].faces.up.tint).toBe('#48b518');
		expect((await resolveIcon(res, 'minecraft:chest')).spec).toBeNull();
	});

	it("reads 1.12 mods' Forge blockstates, flagging a variant picked for a damage value", async () => {
		const res = await Resources.load(
			[
				await jar('thermal.jar', {
					'assets/thermalfoundation/blockstates/material.json': json({
						forge_marker: 1,
						defaults: { model: 'builtin/generated', textures: { layer0: 'blocks/dirt' } },
						variants: { type: { dustiron: { textures: { layer0: 'thermalfoundation:items/material/dust_iron' } }, dustgold: { textures: { layer0: 'thermalfoundation:items/material/dust_gold' } } } }
					}),
					'assets/thermalfoundation/blockstates/ore.json': json({
						forge_marker: 1,
						defaults: { model: 'cube_all' },
						variants: { type: { copper: { textures: { all: 'thermalfoundation:blocks/ore/ore_copper' } } } }
					}),
					'assets/tconstruct/blockstates/ingots.json': json({
						forge_marker: 1,
						defaults: { model: 'forge:item-layer' },
						variants: { cobalt: [{ textures: { layer0: 'tconstruct:items/materials/ingot_cobalt' } }], ardite: [{ textures: { layer0: 'tconstruct:items/materials/ingot_ardite' } }] }
					}),
					'assets/enderio/models/item/item_dark_steel_helmet.json': json({ parent: 'item/generated', textures: { layer0: 'enderio:items/helmet' } })
				})
			],
			await vanilla()
		);
		expect(await resolveIcon(res, 'thermalfoundation:material', 1)).toEqual({
			spec: { kind: 'flat', layers: [{ texture: 'thermalfoundation:items/material/dust_gold', tint: null }] },
			exact: false,
			variant: true,
			variantOf: 'dustgold'
		});
		// One variant only: not a guess. Its model "cube_all" is Minecraft's.
		expect(await resolveIcon(res, 'thermalfoundation:ore', 0)).toMatchObject({ spec: { kind: 'block' }, exact: true });
		expect(await resolveIcon(res, 'tconstruct:ingots', 1)).toMatchObject({ spec: { layers: [{ texture: 'tconstruct:items/materials/ingot_ardite' }] }, exact: false });
		// A worn armour piece: its plain item model, not flagged.
		expect(await resolveIcon(res, 'enderio:item_dark_steel_helmet', 37)).toMatchObject({ spec: { kind: 'flat' }, exact: true });
	});

	it("names vanilla 1.12 variants by its own scheme, and tries mods' usual ones", () => {
		expect(variantModels('minecraft', 'wool', 14)).toEqual(['red_wool', 'wool']);
		expect(variantModels('minecraft', 'dye', 4)).toEqual(['dye_blue', 'dye']);
		expect(variantModels('minecraft', 'log', 5)).toEqual(['spruce_log', 'log']);
		expect(variantModels('minecraft', 'diamond', 0)).toEqual(['diamond']);
		expect(variantModels('somemod', 'gem', 2)).toEqual(['gem_2', 'gem2', 'gem/2', 'gem.2', 'magenta_gem', 'gem_magenta', 'gem']);
	});

	it("uses Minecraft's textures only once the EULA is answered, and serves nothing outside the jars", async () => {
		const instance = await createInstance(
			{ modloader: 'forge', minecraftVersion: '1.12.2' },
			{
				'mods/gems.jar': zipBuffer({
					'assets/gems/models/item/ruby.json': json({ parent: 'item/generated', textures: { layer0: 'gems:items/ruby' } }),
					'assets/gems/textures/items/ruby.png': PNG
				})
			}
		);
		// The client jar as if already downloaded for this version.
		await fs.mkdir(CLIENT_DIR, { recursive: true });
		await fs.copyFile(await vanilla(), path.join(CLIENT_DIR, '1.12.2.jar'));

		let answer = await iconsFor(instance, [{ id: 'gems:ruby', damage: null }, { id: 'minecraft:diamond', damage: null }]);
		expect(answer.vanilla).toBe(false);
		// The mod's own item resolves to its flat layer even without Minecraft's jar.
		expect(answer.icons['gems:ruby'].spec).toMatchObject({ kind: 'flat', layers: [{ texture: 'gems:items/ruby' }] });
		expect(answer.icons['minecraft:diamond'].spec).toBeNull();

		saveMapSettings(instance.id, { eulaAccepted: true });
		answer = await iconsFor(instance, [{ id: 'minecraft:diamond', damage: null }]);
		expect(answer.vanilla).toBe(true);
		expect(answer.icons['minecraft:diamond'].spec).toMatchObject({ kind: 'flat' });

		expect(await iconTexture(instance, 'gems:items/ruby')).toEqual(PNG);
		expect(await iconTexture(instance, 'minecraft:items/diamond')).toEqual(PNG);
		expect(await iconTexture(instance, 'gems:../../../etc/passwd')).toBeNull();
		expect(await iconTexture(instance, '/etc/passwd')).toBeNull();
	});

	it('names items from the language files, by the keys the game and 1.12 mods use', () => {
		const lang = new Map([
			['item.minecraft.diamond', 'Diamond'],
			['block.mymod.marble', 'Marble'],
			['item.chestSack.name', 'Sack of Holding'],
			['tile.thermalfoundation.ore.name', 'Ore'],
			['item.botania:manaRingGreater.name', 'Greater Band of Mana'],
			['item.pe_life_stone.name', 'Life Stone']
		]);
		expect(itemName('minecraft:diamond', lang)).toBe('Diamond');
		expect(itemName('mymod:marble', lang)).toBe('Marble');
		expect(itemName('cyclicmagic:chest_sack', lang)).toBe('Sack of Holding');
		expect(itemName('thermalfoundation:ore', lang)).toBe('Ore');
		// The registry lower-cases what the key keeps in camel case.
		expect(itemName('botania:manaringgreater', lang)).toBe('Greater Band of Mana');
		// The id already starts with item.
		expect(itemName('projecte:item.pe_life_stone', lang)).toBe('Life Stone');
		expect(itemName('projecte:item.pe_unknown_thing', lang)).toBe('Pe Unknown Thing');
		// Nothing found: the id, tidied up.
		expect(itemName('nuclearcraft:heat_exchanger_tube', lang)).toBe('Heat Exchanger Tube');
	});

	it('reads the lang files once per set of resources', async () => {
		// Every variant's name looks in them: read per item, a big pack's ~100k lines made
		// 500 icons take 20 s, and side by side they ran the server out of memory.
		const res = await Resources.load([await jar('a.jar', { 'assets/a/lang/en_us.lang': 'item.a.name=A\n' })], null);
		expect(await res.lang()).toBe(await res.lang());
	});

	it('names a 1.12 variant by its own lang key, from the blockstate the damage picks', async () => {
		const model = json({ parent: 'block/cube_all', textures: { all: 'eu:blocks/chest' } });
		const instance = await createInstance(
			{ modloader: 'forge', minecraftVersion: '1.12.2' },
			{
				'mods/eu.jar': zipBuffer({
					'assets/eu/blockstates/storage_0.json': json({
						forge_marker: 1,
						defaults: { model: 'eu:chest' },
						variants: { type: { memory_chest_0: {}, handy_chest_0: {}, jsu: {}, unnamed: {} }, facing: { north: {}, south: {} } }
					}),
					'assets/eu/models/block/chest.json': model,
					'assets/eu/lang/en_us.lang': 'tile.eu.jsu.name=Junk Storage Unit\ntile.eu.memory_chest_0.name=Small Memory Chest\ntile.eu.storage_0.Handy_Chest_0.name=Handy Chest\n'
				})
			}
		);
		const { icons } = await iconsFor(instance, [
			{ id: 'eu:storage_0', damage: 2 },
			{ id: 'eu:storage_0', damage: 0 },
			{ id: 'eu:storage_0', damage: 1 },
			{ id: 'eu:storage_0', damage: 3 }
		]);
		expect(icons['eu:storage_0@2']).toMatchObject({ variantOf: 'jsu', name: 'Junk Storage Unit', variant: true });
		// Damage 0 is the first variant (iconKey leaves 0 out).
		expect(icons['eu:storage_0']).toMatchObject({ variantOf: 'memory_chest_0', name: 'Small Memory Chest' });
		// Under the id, as Thermal does (item.thermalfoundation.material.dustPetrotheum.name).
		expect(icons['eu:storage_0@1']).toMatchObject({ variantOf: 'handy_chest_0', name: 'Handy Chest' });
		// No lang line for it: no name, so the page keeps the id's.
		expect(icons['eu:storage_0@3'].name).toBeUndefined();
	});

	it('lists every item: 1.12 from the world\'s registry, newer ones from item definitions or models', async () => {
		const tag = (type: string, value: unknown) => ({ type, value }) as never;
		const compound = (entries: [string, unknown][]) => tag('compound', entries);
		const entry = (id: string, n: number) => compound([['K', tag('string', id)], ['V', tag('int', n)]]);
		const ids = { type: 'list', itemType: 'compound', value: [entry('minecraft:stone', 1), entry('gems:ruby', 4096), entry('wiz:charm_flight', 4097), entry('contenttweaker:core_of_undeath', 4098), entry('gems:sapphire', 4099)] } as never;
		const items = compound([['ids', ids]]);
		const registries = compound([['minecraft:items', items]]);
		const registry = writeNbt({ name: '', gzipped: true, root: compound([['FML', compound([['Registries', registries]])]]) });
		const old = await createInstance(
			{ modloader: 'forge', minecraftVersion: '1.12.2' },
			{
				'server.properties': 'level-name=world\n',
				'world/level.dat': registry,
				'mods/gems.jar': zipBuffer({ 'assets/gems/lang/en_US.lang': 'item.ruby.name=Ruby\nitem.sapphire.name=Sapphire\n', 'assets/gems/models/item/ruby.json': '{}' }),
				// .lang keys are properties-style: the colon is escaped.
				'mods/wiz.jar': zipBuffer({ 'assets/wiz/lang/en_us.lang': 'item.wiz\\:charm_flight.name=Charm of Flight\n' }),
				// A pack's own assets (ResourceLoader's resources/, ContentTweaker items): names, models and textures.
				'resources/contenttweaker/lang/en_us.lang': 'item.contenttweaker.core_of_undeath.name=Core of Undeath\n',
				'resources/contenttweaker/models/item/core_of_undeath.json': json({ parent: 'item/generated', textures: { layer0: 'contenttweaker:items/core_of_undeath' } }),
				'resources/contenttweaker/textures/items/core_of_undeath.png': PNG,
				'resources/gems/lang/en_us.lang': 'item.ruby.name=Polished Ruby\n'
			}
		);
		expect(await itemChoices(old)).toEqual([
			{ id: 'contenttweaker:core_of_undeath', name: 'Core of Undeath' },
			// The pack's folder overrides the mod, as in the game.
			{ id: 'gems:ruby', name: 'Polished Ruby' },
			// Key by key: the mod's other names stay.
			{ id: 'gems:sapphire', name: 'Sapphire' },
			{ id: 'minecraft:stone', name: 'Stone' },
			{ id: 'wiz:charm_flight', name: 'Charm of Flight' }
		]);
		const { icons } = await iconsFor(old, [{ id: 'contenttweaker:core_of_undeath', damage: null }]);
		expect(icons['contenttweaker:core_of_undeath'].spec).toEqual({ kind: 'flat', layers: [{ texture: 'contenttweaker:items/core_of_undeath', tint: null }] });
		expect(await iconTexture(old, 'contenttweaker:items/core_of_undeath')).toEqual(PNG);

		const modern = await createInstance(
			{ modloader: 'fabric', minecraftVersion: '1.21.4' },
			{
				'mods/a.jar': zipBuffer({
					'assets/a/items/wand.json': '{}',
					'assets/a/models/item/wand.json': '{}',
					'assets/a/models/item/wand_charged.json': '{}',
					'assets/a/lang/en_us.json': JSON.stringify({ 'item.a.wand': 'Wand' })
				}),
				'mods/b.jar': zipBuffer({ 'assets/b/models/item/gear.json': '{}', 'assets/b/models/item/generated.json': '{}' })
			}
		);
		// a has 1.21.4 definitions: exactly those; b only models, its own base model left out.
		expect(await itemChoices(modern)).toEqual([
			{ id: 'a:wand', name: 'Wand' },
			{ id: 'b:gear', name: 'Gear' }
		]);
	});
});

