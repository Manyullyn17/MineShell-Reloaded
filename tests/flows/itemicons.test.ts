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
			['item.pe_life_stone.name', 'Life Stone'],
			['tile.chest.name', 'Chest'],
			['tile.appliedenergistics2.chest.name', 'ME Chest'],
			['tile.stonebrick.name', 'Cobblestone'],
			['tile.stonebricksmooth.name', 'Stone Bricks'],
			['item.IC2Dust.name', '%1$s Dust'],
			['item.cos.crafting_table', '%1$s%2$s%3$s']
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
		// The mod's own key before the bare one, which is vanilla's chest.
		expect(itemName('appliedenergistics2:chest', lang)).toBe('ME Chest');
		expect(itemName('minecraft:chest', lang)).toBe('Chest');
		// 1.12's tile.stonebrick is cobblestone's key.
		expect(itemName('minecraft:stonebrick', lang)).toBe('Stone Bricks');
		// Templates the mod fills in its code: the gaps marked; only gaps, the id's name.
		expect(itemName('ic2:IC2Dust', lang)).toBe('… Dust');
		expect(itemName('cos:crafting_table', lang)).toBe('Crafting Table');
		// Nothing found: the id, tidied up.
		expect(itemName('nuclearcraft:heat_exchanger_tube', lang)).toBe('Heat Exchanger Tube');
	});

	it('draws the chests the game draws in code from its chest models, in both texture layouts', async () => {
		type Spec = { kind: string; rotation: number[]; quads: { corners: number[][]; face: { texture: string; uv: number[] } }[] };
		// The latch's front: the face at the chest's front (z 16) between x 7 and 9.
		const latch = (spec: Spec) =>
			spec.quads.find((q) => q.corners.every((c) => Math.abs(c[2] - 16) < 1e-6 && c[0] > 6.9 && c[0] < 9.1))!;
		const ys = (q: Spec['quads'][number]) => q.corners.map((c) => Math.round(c[1] * 1000) / 1000);

		// Before 1.15: ModelChest, built upside down and turned over, textures the right way up.
		const old = await Resources.load([], await jar('c.jar', { 'assets/minecraft/textures/entity/chest/ender.png': PNG }));
		const before = (await resolveIcon(old, 'minecraft:ender_chest')).spec as Spec;
		expect(before).toMatchObject({ kind: 'block', rotation: [30, 45, 0] });
		expect(Math.min(...ys(latch(before)))).toBe(7);
		expect(Math.max(...ys(latch(before)))).toBe(11);
		expect(latch(before).face).toEqual({ texture: 'minecraft:entity/chest/ender', uv: [0.25, 0.25, 0.75, 1.25], tint: null });

		// 1.15+ (split double chests): the upright ChestModel, its textures drawn upside down.
		const modern = await Resources.load(
			[],
			await jar('c.jar', { 'assets/minecraft/textures/entity/chest/normal.png': PNG, 'assets/minecraft/textures/entity/chest/normal_left.png': PNG })
		);
		const after = (await resolveIcon(modern, 'minecraft:chest')).spec as Spec;
		expect(Math.min(...ys(latch(after)))).toBe(7);
		expect(Math.max(...ys(latch(after)))).toBe(11);
		expect(latch(after).face.uv).toEqual([1, 0.25, 1.5, 1.25]);

		// 1.21.4: the item definition names a special chest model and its texture.
		const definitions = await Resources.load(
			[],
			await jar('c.jar', {
				'assets/minecraft/items/trapped_chest.json': json({
					model: { type: 'minecraft:select', cases: [], fallback: { type: 'minecraft:special', base: 'minecraft:item/trapped_chest', model: { type: 'minecraft:chest', texture: 'minecraft:trapped' } } }
				}),
				'assets/minecraft/textures/entity/chest/trapped.png': PNG,
				'assets/minecraft/textures/entity/chest/normal_left.png': PNG
			})
		);
		const trapped = (await resolveIcon(definitions, 'minecraft:trapped_chest')).spec as Spec;
		expect(new Set(trapped.quads.map((q) => q.face.texture))).toEqual(new Set(['minecraft:entity/chest/trapped']));
	});

	it('draws shulker boxes the game draws in code, by every name the versions give them', async () => {
		const textures = Object.fromEntries(['shulker', 'shulker_red', 'shulker_silver'].map((t) => [`assets/minecraft/textures/entity/shulker/${t}.png`, PNG]));
		const res = await Resources.load(
			[],
			await jar('c.jar', {
				...textures,
				// 1.21.4+: the item definition names the texture.
				'assets/minecraft/items/black_shulker_box.json': json({
					model: { type: 'minecraft:special', base: 'minecraft:item/black_shulker_box', model: { type: 'minecraft:shulker_box', texture: 'minecraft:shulker_red' } }
				})
			})
		);
		const spec = (await resolveIcon(res, 'minecraft:red_shulker_box')).spec as { kind: string; rotation: number[]; elements: { from: number[]; to: number[]; faces: Record<string, { texture: string; uv: number[] }> }[] };
		expect(spec).toMatchObject({ kind: 'block', rotation: [30, 45, 0] });
		// The base inside the lid, set back so the lid's faces (with holes) are in front of it.
		expect(spec.elements.map((e) => [e.from, e.to])).toEqual([
			[[0.05, 0, 0.05], [15.95, 8, 15.95]],
			[[0, 4, 0], [16, 16, 16]]
		]);
		expect(spec.elements[1].faces.up).toEqual({ texture: 'minecraft:entity/shulker/shulker_red', uv: [4, 0, 8, 4], tint: null });
		expect(spec.elements[0].faces.south.uv).toEqual([4, 11, 8, 13]);
		const texture = async (id: string) => ((await resolveIcon(res, id)).spec as typeof spec | null)?.elements[1].faces.up.texture;
		expect(await texture('minecraft:shulker_box')).toBe('minecraft:entity/shulker/shulker');
		expect(await texture('minecraft:silver_shulker_box')).toBe('minecraft:entity/shulker/shulker_silver');
		expect(await texture('minecraft:black_shulker_box')).toBe('minecraft:entity/shulker/shulker_red');
		expect((await resolveIcon(res, 'minecraft:green_shulker_box')).spec).toBeNull();
	});

	it('reads 26.x textures given as { sprite }', async () => {
		const res = await Resources.load(
			[],
			await jar('c.jar', {
				'assets/minecraft/items/glass.json': json({ model: { type: 'minecraft:model', model: 'minecraft:block/glass' } }),
				'assets/minecraft/models/block/glass.json': json({ parent: 'minecraft:block/cube_all', textures: { all: { sprite: 'minecraft:block/glass', force_translucent: true } } })
			})
		);
		const glass = (await resolveIcon(res, 'minecraft:glass')).spec as { elements: { faces: Record<string, { texture: string }> }[] };
		expect(glass.elements[0].faces.up.texture).toBe('minecraft:block/glass');
	});

	it('draws the shield the game draws in code, from either place its texture has been', async () => {
		for (const texture of ['entity/shield_base_nopattern', 'entity/shield/shield_base_nopattern']) {
			const res = await Resources.load([], await jar('c.jar', { [`assets/minecraft/textures/${texture}.png`]: PNG }));
			const spec = (await resolveIcon(res, 'minecraft:shield')).spec as { rotation: number[]; elements: { from: number[]; to: number[]; faces: Record<string, { texture: string; uv: number[] }> }[] };
			// The handle behind the 12x22x1 plate, whose front is the texture's (1,1) square.
			expect(spec.elements.map((e) => [e.from, e.to])).toEqual([
				[[7, 5, 7], [9, 11, 13]],
				[[2, -3, 6], [14, 19, 7]]
			]);
			expect(spec.elements[1].faces.north).toEqual({ texture: `minecraft:${texture}`, uv: [0.25, 0.25, 3.25, 5.75], tint: null });
			expect(spec.rotation).toEqual([15, 220, 0]);
		}
		// 1.21.4+: the item definition names the special shield model.
		const definitions = await Resources.load(
			[],
			await jar('c.jar', {
				'assets/minecraft/items/shield.json': json({
					model: { type: 'minecraft:condition', property: 'minecraft:using_item', on_false: { type: 'minecraft:special', base: 'minecraft:item/shield', model: { type: 'minecraft:shield' } } }
				}),
				'assets/minecraft/textures/entity/shield/shield_base_nopattern.png': PNG
			})
		);
		expect((await resolveIcon(definitions, 'minecraft:shield')).spec).toMatchObject({ kind: 'block' });
	});

	it('draws heads, banners, beds, the conduit, the decorated pot and copper golem statues the game draws in code', async () => {
		type Spec = { kind: string; quads: { face: { texture: string; tint: string | null } }[]; scale: number } | null;
		const textures = (spec: Spec) => new Set(spec?.quads.map((q) => q.face.texture + (q.face.tint ? ` ${q.face.tint}` : '')));
		const files = (paths: string[]) => Object.fromEntries(paths.map((p) => [`assets/minecraft/textures/${p}.png`, PNG]));

		// Before item definitions: by id, from the version's own texture places.
		const legacy = await Resources.load(
			[],
			await jar('c.jar', files(['entity/skeleton/skeleton', 'entity/player/wide/steve', 'entity/banner_base', 'entity/banner/base', 'entity/bed/red', 'entity/conduit/base', 'entity/decorated_pot/decorated_pot_base', 'entity/decorated_pot/decorated_pot_side']))
		);
		const icon = async (id: string, damage: number | null = null) => (await resolveIcon(legacy, `minecraft:${id}`, damage)).spec as Spec;
		expect(textures(await icon('skeleton_skull'))).toEqual(new Set(['minecraft:entity/skeleton/skeleton']));
		expect(textures(await icon('player_head'))).toEqual(new Set(['minecraft:entity/player/wide/steve']));
		// A plain banner: the pole, bar and cloth, and the base layer tinted in the banner's colour.
		expect(textures(await icon('red_banner'))).toEqual(new Set(['minecraft:entity/banner_base', 'minecraft:entity/banner/base #b02e26']));
		expect(textures(await icon('red_bed'))).toEqual(new Set(['minecraft:entity/bed/red']));
		expect(textures(await icon('conduit'))).toEqual(new Set(['minecraft:entity/conduit/base']));
		expect(textures(await icon('decorated_pot'))).toEqual(
			new Set(['minecraft:entity/decorated_pot/decorated_pot_base', 'minecraft:entity/decorated_pot/decorated_pot_side'])
		);
		// Sized as each item model shows it, against a block's 0.625.
		expect((await icon('skeleton_skull'))?.scale).toBeCloseTo(1.6);
		expect(await icon('zombie_head')).toBeNull();

		// 1.12: one id each, the damage picks the kind or colour (banners count from black, beds from white; light gray is silver).
		const old = await Resources.load([], await jar('c.jar', files(['entity/creeper/creeper', 'entity/banner_base', 'entity/banner/base', 'entity/bed/silver'])));
		const oldIcon = async (id: string, damage: number) => (await resolveIcon(old, `minecraft:${id}`, damage)).spec as Spec;
		expect(textures(await oldIcon('skull', 4))).toEqual(new Set(['minecraft:entity/creeper/creeper']));
		expect(textures(await oldIcon('banner', 1))).toContain('minecraft:entity/banner/base #b02e26');
		expect(textures(await oldIcon('bed', 8))).toEqual(new Set(['minecraft:entity/bed/silver']));

		// 1.21.4+: the item definition's special model says what to draw.
		const definitions = await Resources.load(
			[],
			await jar('c.jar', {
				...files(['entity/piglin/piglin', 'entity/bed/blue', 'entity/copper_golem/oxidized_copper_golem', 'entity/banner/banner_base', 'entity/banner/base']),
				'assets/minecraft/items/piglin_head.json': json({ model: { type: 'minecraft:special', base: 'minecraft:item/template_skull', model: { type: 'minecraft:head', kind: 'piglin' } } }),
				'assets/minecraft/items/blue_bed.json': json({ model: { type: 'minecraft:special', base: 'minecraft:item/blue_bed', model: { type: 'minecraft:bed', texture: 'minecraft:blue' } } }),
				'assets/minecraft/items/blue_banner.json': json({ model: { type: 'minecraft:special', base: 'minecraft:item/template_banner', model: { type: 'minecraft:banner', color: 'blue' } } }),
				'assets/minecraft/items/oxidized_copper_golem_statue.json': json({
					model: {
						type: 'minecraft:select',
						block_state_property: 'copper_golem_pose',
						cases: [{ when: 'sitting', model: { type: 'minecraft:special', base: 'x', model: { type: 'minecraft:copper_golem_statue', pose: 'sitting', texture: 'minecraft:textures/entity/copper_golem/oxidized_copper_golem.png' } } }],
						fallback: { type: 'minecraft:special', base: 'x', model: { type: 'minecraft:copper_golem_statue', pose: 'standing', texture: 'minecraft:textures/entity/copper_golem/oxidized_copper_golem.png' } }
					}
				})
			})
		);
		const def = async (id: string) => (await resolveIcon(definitions, `minecraft:${id}`)).spec as Spec;
		expect(textures(await def('piglin_head'))).toEqual(new Set(['minecraft:entity/piglin/piglin']));
		expect(textures(await def('blue_bed'))).toEqual(new Set(['minecraft:entity/bed/blue']));
		expect(textures(await def('blue_banner'))).toEqual(new Set(['minecraft:entity/banner/banner_base', 'minecraft:entity/banner/base #3c44aa']));
		expect(textures(await def('oxidized_copper_golem_statue'))).toEqual(new Set(['minecraft:entity/copper_golem/oxidized_copper_golem']));
	});

	it("takes the trident's inventory model over its 3D one", async () => {
		const res = await Resources.load(
			[],
			await jar('c.jar', {
				'assets/minecraft/items/trident.json': json({
					model: {
						type: 'minecraft:select',
						property: 'minecraft:display_context',
						cases: [{ when: ['gui', 'ground', 'fixed'], model: { type: 'minecraft:model', model: 'minecraft:item/trident' } }],
						fallback: { type: 'minecraft:special', base: 'minecraft:item/trident_in_hand', model: { type: 'minecraft:trident' } }
					}
				}),
				'assets/minecraft/models/item/trident.json': json({ parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/trident' } })
			})
		);
		expect((await resolveIcon(res, 'minecraft:trident')).spec).toEqual({ kind: 'flat', layers: [{ texture: 'minecraft:item/trident', tint: null }] });
	});

	it('falls back to a texture numbered by damage when the models are picked in code', async () => {
		const instance = await createInstance(
			{ modloader: 'forge', minecraftVersion: '1.12.2' },
			{
				'mods/pe.jar': zipBuffer({
					// A series from 1, in a subfolder; the id carries the mod's prefix.
					...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`assets/projecte/textures/items/stars/klein_star_${n}.png`, PNG])),
					'assets/projecte/lang/en_us.lang': 'item.pe_klein_star_6.name=Klein Star Omega\n'
				}),
				'mods/eu.jar': zipBuffer({
					// A series from 0.
					'assets/enderutilities/textures/items/handybag_0.png': PNG,
					'assets/enderutilities/textures/items/handybag_1.png': PNG,
					'assets/enderutilities/lang/en_us.lang': 'item.enderutilities.handybag_1.name=Handy Bag (Large)\n'
				}),
				// A plain texture beside the numbers: those are a bow's draw frames.
				'mods/aoa.jar': zipBuffer({
					// The model in a subfolder, found by its file name.
					'assets/aoa3/models/item/weapons/bows/predatious_bow.json': json({ parent: 'item/generated', textures: { layer0: 'aoa3:items/weapons/bows/predatious_bow' } }),
					'assets/aoa3/models/item/generated.json': json({ parent: 'builtin/generated' }),
					'assets/aoa3/textures/items/weapons/bows/deep_bow.png': PNG,
					'assets/aoa3/textures/items/weapons/bows/deep_bow_0.png': PNG,
					'assets/aoa3/textures/items/weapons/bows/deep_bow_1.png': PNG
				})
			}
		);
		const { icons } = await iconsFor(instance, [
			{ id: 'projecte:item.pe_klein_star', damage: 5 },
			{ id: 'enderutilities:handybag', damage: 1 },
			{ id: 'enderutilities:handybag', damage: 7 },
			{ id: 'aoa3:deep_bow', damage: 1 }
		]);
		const bow = await iconsFor(instance, [{ id: 'aoa3:predatious_bow', damage: 3 }]);
		expect(bow.icons['aoa3:predatious_bow@3']).toEqual({ spec: { kind: 'flat', layers: [{ texture: 'aoa3:items/weapons/bows/predatious_bow', tint: null }] }, exact: true });
		expect(icons['aoa3:deep_bow@1']).toEqual({ spec: { kind: 'flat', layers: [{ texture: 'aoa3:items/weapons/bows/deep_bow', tint: null }] }, exact: true });
		expect(icons['projecte:item.pe_klein_star@5']).toMatchObject({
			spec: { kind: 'flat', layers: [{ texture: 'projecte:items/stars/klein_star_6' }] },
			exact: false,
			name: 'Klein Star Omega'
		});
		expect(icons['enderutilities:handybag@1']).toMatchObject({ spec: { layers: [{ texture: 'enderutilities:items/handybag_1' }] }, name: 'Handy Bag (Large)' });
		// No such number: nothing, rather than another variant's picture.
		expect(icons['enderutilities:handybag@7'].spec).toBeNull();
	});

	it('names vanilla 1.12 variants by the keys the game uses for them', async () => {
		const instance = await createInstance({ modloader: 'forge', minecraftVersion: '1.12.2' }, {});
		saveMapSettings(instance.id, { eulaAccepted: true });
		await fs.mkdir(CLIENT_DIR, { recursive: true });
		await fs.writeFile(
			path.join(CLIENT_DIR, '1.12.2.jar'),
			zipBuffer({
				'assets/minecraft/lang/en_us.lang': [
					'tile.stone.stone.name=Stone',
					'tile.stone.granite.name=Granite',
					'tile.wood.spruce.name=Spruce Wood Planks',
					'tile.cloth.lightBlue.name=Light Blue Wool',
					'tile.flower2.blueOrchid.name=Blue Orchid',
					'item.dyePowder.blue.name=Lapis Lazuli',
					'item.fish.salmon.cooked.name=Cooked Salmon'
				].join('\n')
			})
		);
		const { icons } = await iconsFor(instance, [
			{ id: 'minecraft:stone', damage: 0 },
			{ id: 'minecraft:stone', damage: 1 },
			{ id: 'minecraft:planks', damage: 1 },
			{ id: 'minecraft:wool', damage: 3 },
			{ id: 'minecraft:red_flower', damage: 1 },
			// Dye counts from black: 4 is blue.
			{ id: 'minecraft:dye', damage: 4 },
			{ id: 'minecraft:cooked_fish', damage: 1 },
			// Wear, not a variant: no name of its own.
			{ id: 'minecraft:diamond_pickaxe', damage: 30 }
		]);
		expect(Object.fromEntries(Object.entries(icons).map(([k, v]) => [k, v.name]))).toEqual({
			'minecraft:stone': 'Stone',
			'minecraft:stone@1': 'Granite',
			'minecraft:planks@1': 'Spruce Wood Planks',
			'minecraft:wool@3': 'Light Blue Wool',
			'minecraft:red_flower@1': 'Blue Orchid',
			'minecraft:dye@4': 'Lapis Lazuli',
			'minecraft:cooked_fish@1': 'Cooked Salmon',
			'minecraft:diamond_pickaxe@30': undefined
		});
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

