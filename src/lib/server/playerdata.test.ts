import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseNbt, writeNbt, type Compound, type NbtFile, type Tag } from './nbt';
import { applyEdits, parseEdits, playerView, PlayerDataError, shortestFloat } from './playerdata';

const b = (value: number): Tag => ({ type: 'byte', value });
const i = (value: number): Tag => ({ type: 'int', value });
const s = (value: string): Tag => ({ type: 'string', value });
const c = (...entries: [string, Tag][]): Compound => ({ type: 'compound', value: entries });
const list = (...value: Tag[]): Tag => ({ type: 'list', itemType: value.length ? value[0].type : 'end', value });

function player(dataVersion: number | null, ...entries: [string, Tag][]): NbtFile {
	const root = c(...(dataVersion === null ? [] : ([['DataVersion', i(dataVersion)]] as [string, Tag][])), ...entries);
	return { name: '', root, gzipped: true };
}

/** What the server would read back. */
const reread = (file: NbtFile) => parseNbt(writeNbt(file));

describe('playerView', () => {
	it('reads a 1.12 inventory: Count byte, numeric Damage, armor and offhand in Inventory', () => {
		const file = player(
			1343,
			['Inventory', list(
				c(['Slot', b(0)], ['id', s('minecraft:wool')], ['Count', b(12)], ['Damage', { type: 'short', value: 14 }]),
				c(['Slot', b(103)], ['id', s('minecraft:diamond_helmet')], ['Count', b(1)], ['Damage', { type: 'short', value: 0 }],
					['tag', c(['display', c(['Name', s('Lucky Hat')])])]),
				c(['Slot', b(-106)], ['id', s('minecraft:shield')], ['Count', b(1)], ['Damage', { type: 'short', value: 0 }])
			)],
			['Dimension', i(-1)]
		);
		const view = playerView(reread(file));
		expect(view.format).toBe('legacy');
		expect(view.items.map((it) => [it.section, it.slot, it.id, it.count, it.damage, it.name, it.hasData])).toEqual([
			['main', 0, 'minecraft:wool', 12, 14, null, false],
			['armor', 103, 'minecraft:diamond_helmet', 1, 0, 'Lucky Hat', true],
			['offhand', -106, 'minecraft:shield', 1, 0, null, false]
		]);
		// Before 1.16 the dimension is a number, picked from a list.
		expect(view.fields.find((f) => f.key === 'dimension')).toMatchObject({ kind: 'select', value: '-1', path: ['Dimension'] });
	});

	it('reads 1.21.5+ equipment and component counts', () => {
		const file = player(
			4325,
			['Inventory', list(c(['Slot', b(8)], ['id', s('minecraft:torch')], ['count', i(64)]))],
			['equipment', c(
				['feet', c(['id', s('minecraft:iron_boots')], ['count', i(1)], ['components', c(['minecraft:custom_name', c(['text', s('Boots')])])])],
				['offhand', c(['id', s('minecraft:totem_of_undying')], ['count', i(1)])]
			)],
			['EnderItems', list(c(['Slot', b(26)], ['id', s('minecraft:elytra')]))]
		);
		const view = playerView(reread(file));
		expect(view).toMatchObject({ format: 'components', equipment: true });
		expect(view.items.map((it) => [it.section, it.slot, it.id, it.count, it.name])).toEqual([
			['main', 8, 'minecraft:torch', 64, null],
			// No count means one.
			['ender', 26, 'minecraft:elytra', 1, null],
			['armor', 100, 'minecraft:iron_boots', 1, 'Boots'],
			['offhand', -106, 'minecraft:totem_of_undying', 1, null]
		]);
	});

	it('shows floats as the shortest decimal that is the same float', () => {
		expect(shortestFloat(Math.fround(0.1))).toBe(0.1);
		expect(shortestFloat(Math.fround(3.624004))).toBe(3.624004);
		expect(shortestFloat(20)).toBe(20);
		const view = playerView(player(3955, ['foodExhaustionLevel', { type: 'float', value: Math.fround(3.624004) }]));
		expect(JSON.parse(JSON.stringify(view.tree)).value[1][1]).toEqual({ type: 'float', value: 3.624004 });
	});

	it('sends longs and non-finite floats as strings', () => {
		const view = playerView(player(3955, ['LastCombat', { type: 'long', value: 2n ** 62n }], ['Odd', { type: 'float', value: NaN }]));
		expect(JSON.parse(JSON.stringify(view.tree)).value.slice(1)).toEqual([
			['LastCombat', { type: 'long', value: String(2n ** 62n) }],
			['Odd', { type: 'float', value: 'NaN' }]
		]);
	});
});

describe('applyEdits', () => {
	it('changes values in place, keeping each tag’s type and position', () => {
		const file = player(3955, ['Health', { type: 'float', value: 20 }], ['XpLevel', i(3)], ['Pos', list({ type: 'double', value: 1 }, { type: 'double', value: 64 }, { type: 'double', value: 2 })]);
		applyEdits(file, [
			{ op: 'set', path: ['XpLevel'], value: '30' },
			{ op: 'set', path: ['Pos', 1], value: '100.5' }
		]);
		const root = reread(file).root;
		expect(root.value.map(([k]) => k)).toEqual(['DataVersion', 'Health', 'XpLevel', 'Pos']);
		expect(root.value[2][1]).toEqual(i(30));
		expect((root.value[3][1] as Extract<Tag, { type: 'list' }>).value[1]).toEqual({ type: 'double', value: 100.5 });
	});

	it('refuses values that do not fit the tag', () => {
		const file = player(3955, ['Air', { type: 'short', value: 300 }]);
		expect(() => applyEdits(file, [{ op: 'set', path: ['Air'], value: '40000' }])).toThrow(PlayerDataError);
		expect(() => applyEdits(file, [{ op: 'set', path: ['Air'], value: '1.5' }])).toThrow(/whole number/);
		expect(() => applyEdits(file, [{ op: 'set', path: ['Gone'], value: '1' }])).toThrow(/no longer there/);
	});

	it('adds and removes entries, and an empty list takes the type of what is added', () => {
		const file = player(3955, ['Tags', list()], ['Old', b(1)]);
		applyEdits(file, [
			{ op: 'add', path: ['Tags'], type: 'string', value: 'vip' },
			{ op: 'add', path: [], name: 'Custom', type: 'compound' },
			{ op: 'add', path: ['Custom'], name: 'level', type: 'int', value: '5' },
			{ op: 'remove', path: ['Old'] }
		]);
		const root = reread(file).root;
		expect(root.value.map(([k]) => k)).toEqual(['DataVersion', 'Tags', 'Custom']);
		expect(root.value[1][1]).toEqual({ type: 'list', itemType: 'string', value: [s('vip')] });
		expect(() => applyEdits(file, [{ op: 'add', path: ['Tags'], type: 'int', value: '1' }])).toThrow(/holds string/);
	});

	it('takes whole structures as SNBT, renames entries and changes a value’s type', () => {
		const file = player(3955, ['Tags', list()], ['count', b(1)], ['Odd', list(i(1))]);
		applyEdits(file, [
			{ op: 'add', path: [], name: 'Ench', type: 'snbt', value: '[{id:"minecraft:sharpness",lvl:5s}]' },
			{ op: 'add', path: ['Tags'], type: 'snbt', value: '"vip"' },
			{ op: 'rename', path: ['count'], name: 'Count' },
			{ op: 'set', path: ['Count'], value: '64', type: 'int' },
			{ op: 'replace', path: ['Odd'], snbt: '{x:1b}' }
		]);
		const root = reread(file).root;
		expect(root.value.map(([k]) => k)).toEqual(['DataVersion', 'Tags', 'Count', 'Odd', 'Ench']);
		expect(root.value[2][1]).toEqual(i(64));
		expect(root.value[3][1]).toEqual(c(['x', b(1)]));
		expect(root.value[4][1]).toEqual(list(c(['id', s('minecraft:sharpness')], ['lvl', { type: 'short', value: 5 }])));
		expect(() => applyEdits(file, [{ op: 'add', path: [], name: 'Bad', type: 'snbt', value: '{a:' }])).toThrow(/not valid/);
		expect(() => applyEdits(file, [{ op: 'rename', path: ['Count'], name: 'Odd' }])).toThrow(/already/);
		expect(() => applyEdits(file, [{ op: 'set', path: ['Ench', 0, 'lvl'], value: '1', type: 'int' }])).not.toThrow();
	});

	it('writes items in the file’s own format', () => {
		const legacy = player(1343, ['Inventory', list()]);
		applyEdits(legacy, [{ op: 'item', section: 'main', slot: 4, id: 'minecraft:wool', count: 3, damage: 14 }]);
		expect(playerView(reread(legacy)).items[0]).toMatchObject({ slot: 4, id: 'minecraft:wool', count: 3, damage: 14 });
		expect(reread(legacy).root.value[1][1]).toEqual(
			list(c(['Slot', b(4)], ['id', s('minecraft:wool')], ['Count', b(3)], ['Damage', { type: 'short', value: 14 }]))
		);

		const modern = player(4325, ['Inventory', list()]);
		applyEdits(modern, [
			{ op: 'item', section: 'main', slot: 0, id: 'minecraft:diamond', count: 64 },
			{ op: 'item', section: 'armor', slot: 103, id: 'minecraft:netherite_helmet', count: 1 }
		]);
		const root = reread(modern).root;
		expect(root.value.find(([k]) => k === 'Inventory')![1]).toEqual(list(c(['Slot', b(0)], ['id', s('minecraft:diamond')], ['count', i(64)])));
		// 1.21.5+: armor goes under equipment, without a Slot.
		expect(root.value.find(([k]) => k === 'equipment')![1]).toEqual(c(['head', c(['id', s('minecraft:netherite_helmet')], ['count', i(1)])]));
	});

	it('keeps an item’s enchantments and names when its id or count changes', () => {
		const file = player(3700, ['Inventory', list(c(['Slot', b(0)], ['id', s('minecraft:diamond_sword')], ['Count', b(1)], ['tag', c(['Enchantments', list(c(['id', s('minecraft:sharpness')]))])]))]);
		applyEdits(file, [{ op: 'item', section: 'main', slot: 0, id: 'minecraft:netherite_sword', count: 1 }]);
		const view = playerView(reread(file));
		expect(view.items[0]).toMatchObject({ id: 'minecraft:netherite_sword', hasData: true });
	});

	it('removes items and refuses bad ids, counts and slots', () => {
		const file = player(3955, ['Inventory', list(c(['Slot', b(5)], ['id', s('minecraft:dirt')], ['count', i(1)]))]);
		applyEdits(file, [{ op: 'removeItem', section: 'main', slot: 5 }]);
		expect(playerView(reread(file)).items).toEqual([]);
		expect(() => applyEdits(file, [{ op: 'item', section: 'main', slot: 0, id: 'dirt block', count: 1 }])).toThrow(/not an item id/);
		expect(() => applyEdits(file, [{ op: 'item', section: 'main', slot: 0, id: 'minecraft:dirt', count: 100 }])).toThrow(/between 1 and 99/);
		expect(() => applyEdits(file, [{ op: 'item', section: 'ender', slot: 27, id: 'minecraft:dirt', count: 1 }])).toThrow(/0 to 26/);
		expect(() => applyEdits(file, [{ op: 'removeItem', section: 'main', slot: 1 }])).toThrow(/already empty/);
	});
});

describe('nbt', () => {
	it('round-trips modified UTF-8 (NUL, accents, characters beyond the BMP) and gzip', () => {
		const file = player(3955, ['Name', s('a\u0000é😀')]);
		const bytes = writeNbt(file);
		expect(zlib.gunzipSync(bytes).includes(Buffer.from([0xc0, 0x80]))).toBe(true);
		expect(reread(file).root.value[1][1]).toEqual(s('a\u0000é😀'));
		expect(writeNbt(parseNbt(bytes)).equals(bytes)).toBe(true);
	});
});

describe('parseEdits', () => {
	it('takes well-formed edits and refuses anything else', () => {
		expect(parseEdits([{ op: 'set', path: ['Pos', 1], value: '64' }, { op: 'removeItem', section: 'ender', slot: 3 }])).toEqual([
			{ op: 'set', path: ['Pos', 1], value: '64' },
			{ op: 'removeItem', section: 'ender', slot: 3 }
		]);
		for (const bad of [null, {}, [{ op: 'set', path: 'Pos', value: '1' }], [{ op: 'add', path: [], type: 'end' }], [{ op: 'item', section: 'hat', slot: 1, id: 'x:y', count: 1 }], [{ op: 'rm' }]]) {
			expect(() => parseEdits(bad)).toThrow(PlayerDataError);
		}
	});
});
