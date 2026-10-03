import { describe, expect, it } from 'vitest';
import type { Compound, Tag } from './nbt';
import { parseSnbt } from './snbt';
import { describeItem, findContainers, readFields, setContainerItem, styleOf, writeFields, PlayerDataError } from './playeritems';

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

	it('finds mod slots in the player file, skipping what the page already shows', () => {
		const root = snbt('{Inventory:[{Slot:0b,id:"minecraft:dirt",count:1}],cardinal_components:{"trinkets:trinkets":{head:{hat:{Items:[{id:"minecraft:leather_helmet",count:1}]}}}}}');
		const containers = findContainers(root, [], COMPONENTS, '', 0, new Set(['Inventory']));
		expect(containers.map((c) => c.label)).toEqual(['cardinal_components › trinkets:trinkets › head › hat']);
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
