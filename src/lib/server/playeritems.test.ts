import { describe, expect, it } from 'vitest';
import type { Compound, Tag } from './nbt';
import { parseSnbt } from './snbt';
import { describeItem, findContainers, readFields, setContainerItem, setKeyedItem, styleOf, writeFields, PlayerDataError } from './playeritems';

const snbt = (text: string) => parseSnbt(text) as Compound;
const LEGACY = styleOf(1343);
const FLAT = styleOf(3700);
const COMPONENTS = styleOf(3955);
const NBT_TEXT = styleOf(4325);

describe('item fields', () => {
	it('reads name, lore, enchantments, unbreakable and durability in every format', () => {
		const cases: [ReturnType<typeof styleOf>, string][] = [
			[LEGACY, '{id:"minecraft:diamond_sword",Count:1b,Damage:5s,tag:{display:{Name:"Edge",Lore:["sharp"]},ench:[{id:16s,lvl:5s}],Unbreakable:1b}}'],
			[FLAT, '{id:"minecraft:diamond_sword",Count:1b,tag:{Damage:5,display:{Name:\'{"text":"Edge"}\',Lore:[\'{"text":"sharp"}\']},Enchantments:[{id:"minecraft:sharpness",lvl:5s}],Unbreakable:1b}}'],
			[COMPONENTS, '{id:"minecraft:diamond_sword",count:1,components:{"minecraft:damage":5,"minecraft:custom_name":\'"Edge"\',"minecraft:lore":[\'{"text":"sharp"}\'],"minecraft:enchantments":{levels:{"minecraft:sharpness":5}},"minecraft:unbreakable":{}}}'],
			[NBT_TEXT, '{id:"minecraft:diamond_sword",count:1,components:{"minecraft:damage":5,"minecraft:custom_name":{text:"Edge"},"minecraft:lore":["sharp"],"minecraft:enchantments":{"minecraft:sharpness":5},"minecraft:unbreakable":{}}}']
		];
		for (const [style, text] of cases) {
			const fields = readFields(snbt(text), style);
			expect(fields).toMatchObject({ name: 'Edge', lore: ['sharp'], unbreakable: true, stored: false });
			expect(fields.enchantments).toEqual([{ id: style === LEGACY ? '16' : 'minecraft:sharpness', level: 5 }]);
			expect(fields.damage).toBe(style === LEGACY ? null : 5);
		}
	});

	it('writes fields in the item’s own format and reads them back', () => {
		const fields = { name: 'Edge', lore: ['one', 'two'], unbreakable: true, damage: 7 };
		for (const [style, enchant] of [[LEGACY, '16'], [FLAT, 'minecraft:sharpness'], [COMPONENTS, 'minecraft:sharpness'], [NBT_TEXT, 'minecraft:sharpness']] as const) {
			const item = snbt(style.format === 'components' ? '{id:"minecraft:iron_sword",count:1}' : '{id:"minecraft:iron_sword",Count:1b}');
			writeFields(item, { ...fields, enchantments: [{ id: enchant, level: 3 }] }, style);
			const back = readFields(item, style);
			expect(back).toMatchObject({ name: 'Edge', lore: ['one', 'two'], unbreakable: true, enchantments: [{ id: enchant, level: 3 }] });
			if (style !== LEGACY) expect(back.damage).toBe(7);
		}
		// 1.13-1.21.4 store text as JSON; 1.21.5 as an NBT text component.
		const flat = snbt('{id:"minecraft:stick",Count:1b}');
		writeFields(flat, { name: 'Wand' }, FLAT);
		expect(flat.value[2][1]).toEqual(snbt('{display:{Name:\'{"text":"Wand","italic":false}\'}}'));
		const modern = snbt('{id:"minecraft:stick",count:1}');
		writeFields(modern, { name: 'Wand', enchantments: [{ id: 'minecraft:mending', level: 1 }] }, NBT_TEXT);
		expect(modern.value[2][1]).toEqual(snbt('{"minecraft:custom_name":"Wand","minecraft:enchantments":{"minecraft:mending":1}}'));
	});

	it('removes emptied fields and leaves no empty data behind, but keeps show_in_tooltip', () => {
		const item = snbt('{id:"minecraft:bow",Count:1b,tag:{display:{Name:\'"Bow"\'},Unbreakable:1b}}');
		writeFields(item, { name: null, unbreakable: false }, FLAT);
		expect(item.value.map(([k]) => k)).toEqual(['id', 'Count']);

		const hidden = snbt('{id:"minecraft:bow",count:1,components:{"minecraft:enchantments":{levels:{"minecraft:power":1},show_in_tooltip:0b}}}');
		writeFields(hidden, { enchantments: [{ id: 'minecraft:power', level: 5 }] }, COMPONENTS);
		expect(readFields(hidden, COMPONENTS).enchantments).toEqual([{ id: 'minecraft:power', level: 5 }]);
		expect(JSON.stringify(hidden)).toContain('show_in_tooltip');
	});

	it('uses stored enchantments on enchanted books', () => {
		const book = snbt('{id:"minecraft:enchanted_book",count:1}');
		writeFields(book, { enchantments: [{ id: 'minecraft:mending', level: 1 }] }, COMPONENTS);
		expect(JSON.stringify(book)).toContain('minecraft:stored_enchantments');
		expect(readFields(book, COMPONENTS)).toMatchObject({ stored: true, enchantments: [{ id: 'minecraft:mending', level: 1 }] });
	});

	it('refuses enchantments that are not ids, or levels out of range', () => {
		const item = snbt('{id:"minecraft:bow",count:1}');
		expect(() => writeFields(item, { enchantments: [{ id: 'power', level: 1 }] }, COMPONENTS)).toThrow(PlayerDataError);
		expect(() => writeFields(item, { enchantments: [{ id: 'minecraft:power', level: 300 }] }, COMPONENTS)).toThrow(/1 to 255/);
		expect(() => writeFields(item, { enchantments: [{ id: 'minecraft:power', level: 1 }] }, LEGACY)).toThrow(/1.12 enchantment number/);
	});
});

describe('containers', () => {
	it('finds shulker contents, bundles, the container component and mod backpacks', () => {
		const shulker = describeItem(snbt('{id:"minecraft:shulker_box",Count:1b,tag:{BlockEntityTag:{Items:[{Slot:3b,id:"minecraft:dirt",Count:5b}]}}}'), 'main', 0, ['Inventory', 0], FLAT)!;
		expect(shulker.containers).toMatchObject([{ path: ['Inventory', 0, 'tag', 'BlockEntityTag', 'Items'], label: 'Contents', size: 27 }]);
		expect(shulker.containers[0].items[0]).toMatchObject({ slot: 3, id: 'minecraft:dirt', count: 5, path: ['Inventory', 0, 'tag', 'BlockEntityTag', 'Items', 0] });

		const modern = describeItem(snbt('{id:"minecraft:shulker_box",count:1,components:{"minecraft:container":[{slot:2,item:{id:"minecraft:stone",count:64}}]}}'), 'main', 1, ['Inventory', 1], COMPONENTS)!;
		expect(modern.containers[0].items[0]).toMatchObject({ slot: 2, id: 'minecraft:stone', count: 64, path: ['Inventory', 1, 'components', 'minecraft:container', 0, 'item'] });

		const bundle = describeItem(snbt('{id:"minecraft:bundle",count:1,components:{"minecraft:bundle_contents":[{id:"minecraft:apple",count:3}]}}'), 'main', 2, ['x'], COMPONENTS)!;
		expect(bundle.containers[0]).toMatchObject({ size: null, items: [{ slot: 0, id: 'minecraft:apple' }] });

		// A Forge item handler: {Items:[{Slot,id,Count}], Size} - empty counts too, its Size says so.
		const backpack = describeItem(snbt('{id:"travelersbackpack:standard",Count:1b,tag:{Inventory:{Items:[],Size:45}}}'), 'main', 3, ['y'], FLAT)!;
		expect(backpack.containers).toMatchObject([{ label: 'Inventory', size: 45, items: [] }]);
	});

	it('reads a slot-keyed compound (Thermal’s satchel) as one container, not the lists inside its items', () => {
		const satchel = describeItem(
			snbt('{id:"thermalexpansion:satchel",Count:1,Damage:4s,tag:{Inventory:{Slot50:{id:"projecte:philosophers_stone",Count:1,Damage:0s},Slot21:{id:"enderio:item_dark_steel_pickaxe",Count:1,Damage:0s,tag:{inventory:[{id:"minecraft:air",Count:2}]}}},Filter:[{id:"minecraft:stone",Count:1b,Damage:0s,Slot:0b}]}}'),
			'main', 16, ['Inventory', 16], LEGACY
		)!;
		expect(satchel.containers.map((c) => [c.label, c.size, c.items.map((i) => [i.slot, i.id])])).toEqual([
			['Inventory', 54, [[50, 'projecte:philosophers_stone'], [21, 'enderio:item_dark_steel_pickaxe']]],
			['Filter', 9, [[0, 'minecraft:stone']]]
		]);
		// The pickaxe's own list is the pickaxe's, shown when it is opened.
		expect(satchel.containers[0].items[1].containers.map((c) => c.label)).toEqual(['inventory']);
	});

	it('does not take enchantment or attribute lists for item lists', () => {
		const sword = describeItem(snbt('{id:"minecraft:diamond_sword",Count:1b,tag:{Enchantments:[{id:"minecraft:sharpness",lvl:5s}]}}'), 'main', 0, ['x'], FLAT)!;
		expect(sword.containers).toEqual([]);
		expect(findContainers(snbt('{attributes:[{id:"minecraft:max_health",base:20d}]}'), [], COMPONENTS, '', 0)).toEqual([]);
	});

	it('adds to a slot-keyed compound in the style of what is there, keeping an int Count', () => {
		const items = snbt('{Slot2:{id:"minecraft:dirt",Count:5,Damage:0s}}');
		setKeyedItem(items, 7, { id: 'minecraft:stone', count: 3 }, LEGACY);
		setKeyedItem(items, 2, { id: 'minecraft:dirt', count: 64 }, LEGACY);
		expect(items).toEqual(snbt('{Slot2:{id:"minecraft:dirt",Count:64,Damage:0s},Slot7:{id:"minecraft:stone",Count:3,Damage:0s}}'));
		setKeyedItem(items, 7, null, LEGACY);
		expect(items.value.map(([k]) => k)).toEqual(['Slot2']);
	});

	it('finds mod slots in the player file, skipping what the page already shows', () => {
		const root = snbt('{Inventory:[{Slot:0b,id:"minecraft:dirt",count:1}],cardinal_components:{"trinkets:trinkets":{head:{hat:{Items:[{id:"minecraft:leather_helmet",count:1}]}}}}}');
		const containers = findContainers(root, [], COMPONENTS, '', 0, new Set(['Inventory']));
		expect(containers.map((c) => c.label)).toEqual(['cardinal_components › trinkets:trinkets › head › hat']);
	});

	it("groups Curios' lists and names each by its slot type", () => {
		const slot = (id: string, items: string) =>
			`{Identifier:"${id}",StacksHandler:{Stacks:{Size:2,Items:[${items}]},Cosmetics:{Size:2,Items:[]},Renders:{Size:2,Renders:[{Render:1b,Slot:0}]}}}`;
		const root = snbt(`{"neoforge:attachments":{"curios:inventory":{Curios:[${slot('ring', '{Slot:0,id:"minecraft:gold_ingot",count:1}')},${slot('belt', '')}]}}}`);
		const containers = findContainers(root, [], COMPONENTS, '', 0);
		expect(containers.map((c) => [c.group?.label, c.label, c.items.length])).toEqual([
			['Curios', 'ring', 1],
			['Curios', 'ring › Cosmetics', 0],
			['Curios', 'belt', 0],
			['Curios', 'belt › Cosmetics', 0]
		]);
		expect(new Set(containers.map((c) => c.group?.id)).size).toBe(1);
	});

	it('puts items into each kind of container in its own shape, and takes them out', () => {
		const put = (text: string, at: string[], slot: number, style = COMPONENTS) => {
			const parent = snbt(text);
			let list: Tag = parent;
			let holder: Tag = parent;
			for (const key of at) {
				holder = list;
				list = (list as Compound).value.find(([k]) => k === key)![1];
			}
			setContainerItem(list as Extract<Tag, { type: 'list' }>, holder, at, slot, { id: 'minecraft:gold_ingot', count: 9 }, style);
			return list;
		};
		expect(put('{"minecraft:container":[]}', ['minecraft:container'], 4)).toEqual(parseSnbt('[{slot:4,item:{id:"minecraft:gold_ingot",count:9}}]'));
		expect(put('{Items:[],Size:9}', ['Items'], 8, FLAT)).toEqual(parseSnbt('[{Slot:8,id:"minecraft:gold_ingot",Count:9b}]'));
		expect(put('{BlockEntityTag:{Items:[{Slot:0b,id:"minecraft:dirt",Count:1b,tag:{x:1}}]}}', ['BlockEntityTag', 'Items'], 0, FLAT)).toEqual(
			parseSnbt('[{Slot:0b,id:"minecraft:gold_ingot",Count:9b,tag:{x:1}}]')
		);
		expect(put('{"minecraft:bundle_contents":[{id:"minecraft:apple",count:1}]}', ['minecraft:bundle_contents'], 1)).toEqual(
			parseSnbt('[{id:"minecraft:apple",count:1},{id:"minecraft:gold_ingot",count:9}]')
		);
		expect(() => put('{Items:[],Size:9}', ['Items'], 9, FLAT)).toThrow(/slots 0 to 8/);
	});
});

describe('what the tooltip shows about an item', () => {
	it('knows vanilla durability, a 1.20.5 max_damage component, and stored energy', () => {
		const item = (snbt: string, style = LEGACY) => describeItem(parseSnbt(snbt), 'main', 0, [], style)!;
		expect(item('{id:"minecraft:diamond_pickaxe",Count:1b,Damage:100s}').maxDamage).toBe(1561);
		expect(item('{id:"minecraft:golden_helmet",Count:1b,Damage:3s}').maxDamage).toBe(77);
		// A mod's tool: its maximum is in its code.
		expect(item('{id:"tconstruct:pickaxe",Count:1b,Damage:5s}').maxDamage).toBeNull();
		expect(item('{id:"mymod:drill",count:1,components:{"minecraft:max_damage":900,"minecraft:damage":20}}', COMPONENTS).maxDamage).toBe(900);
		expect(item('{id:"thermalexpansion:capacitor",Count:1b,tag:{Energy:80000}}').energy).toBe(80000);
		expect(item('{id:"mekanism:energy_tablet",Count:1b,tag:{mekData:{energyStored:1200.5d}}}').energy).toBe(1200.5);
		expect(item('{id:"minecraft:stone",Count:1b}').energy).toBeNull();
	});
});
