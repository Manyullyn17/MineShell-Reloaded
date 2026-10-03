import { describe, expect, it } from 'vitest';
import { parseSnbt, SnbtError } from './snbt';
import { toTree } from './playerdata';
import { treeToSnbt } from '$lib/shared/nbt';

describe('parseSnbt', () => {
	it('reads typed numbers, booleans, strings, lists and arrays', () => {
		expect(parseSnbt('{id:"minecraft:sharpness",lvl:5s}')).toEqual({
			type: 'compound',
			value: [
				['id', { type: 'string', value: 'minecraft:sharpness' }],
				['lvl', { type: 'short', value: 5 }]
			]
		});
		expect(parseSnbt('3b')).toEqual({ type: 'byte', value: 3 });
		expect(parseSnbt('7')).toEqual({ type: 'int', value: 7 });
		expect(parseSnbt('9000000000L')).toEqual({ type: 'long', value: 9000000000n });
		expect(parseSnbt('0.1f')).toEqual({ type: 'float', value: Math.fround(0.1) });
		expect(parseSnbt('2.5')).toEqual({ type: 'double', value: 2.5 });
		expect(parseSnbt('1d')).toEqual({ type: 'double', value: 1 });
		expect(parseSnbt('true')).toEqual({ type: 'byte', value: 1 });
		expect(parseSnbt("'it\\'s'")).toEqual({ type: 'string', value: "it's" });
		expect(parseSnbt('stone')).toEqual({ type: 'string', value: 'stone' });
		// Unquoted strings cannot hold a colon, in Minecraft either.
		expect(() => parseSnbt('minecraft:stone')).toThrow(SnbtError);
		expect(parseSnbt('[1,2]')).toEqual({ type: 'list', itemType: 'int', value: [{ type: 'int', value: 1 }, { type: 'int', value: 2 }] });
		expect(parseSnbt('[]')).toEqual({ type: 'list', itemType: 'end', value: [] });
		expect(parseSnbt('[I; 1, -2]')).toEqual({ type: 'intArray', value: [1, -2] });
		expect(parseSnbt('[B;1b,2b]')).toEqual({ type: 'byteArray', value: [1, 2] });
		expect(parseSnbt('[L;5L]')).toEqual({ type: 'longArray', value: [5n] });
		expect(parseSnbt('{"odd key":1}')).toEqual({ type: 'compound', value: [['odd key', { type: 'int', value: 1 }]] });
	});

	it('says what is wrong and where', () => {
		expect(() => parseSnbt('[1,"a"]')).toThrow(/one type/);
		expect(() => parseSnbt('{a:1')).toThrow(SnbtError);
		expect(() => parseSnbt('300b')).toThrow(/out of range/);
		expect(() => parseSnbt('{a:1,a:2}')).toThrow(/twice/);
		expect(() => parseSnbt('1 2')).toThrow(/after the value/);
	});

	it('reads back what treeToSnbt prints', () => {
		const tag = parseSnbt('{Name:"A \\"quoted\\" one",n:[L;1L,2L],f:0.1f,d:3d,b:[B;1b],l:[{x:1s},{x:2s}],e:[],"k k":{}}');
		for (const indent of [0, 2]) expect(parseSnbt(treeToSnbt(toTree(tag), indent))).toEqual(tag);
	});
});
