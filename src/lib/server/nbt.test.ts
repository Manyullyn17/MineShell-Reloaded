import { describe, expect, it } from 'vitest';
import { NbtError, peekNumber, writeNbt, type Tag } from './nbt';

const compound = (value: [string, Tag][]): Extract<Tag, { type: 'compound' }> => ({ type: 'compound', value });
const raw = (root: Extract<Tag, { type: 'compound' }>) => writeNbt({ name: '', gzipped: false, root });

/** One of every tag kind, nested, so finding a number after it means each was skipped right. */
const everything: [string, Tag][] = [
	['b', { type: 'byte', value: -3 }],
	['s', { type: 'short', value: 300 }],
	['i', { type: 'int', value: 70000 }],
	['l', { type: 'long', value: 5n }],
	['f', { type: 'float', value: 1.5 }],
	['d', { type: 'double', value: 2.25 }],
	['ba', { type: 'byteArray', value: [1, 2, 3] }],
	['str', { type: 'string', value: 'grüße, 世界' }],
	['ia', { type: 'intArray', value: [1, -1, 9] }],
	['la', { type: 'longArray', value: [1n, 2n] }],
	['ints', { type: 'list', itemType: 'int', value: [{ type: 'int', value: 1 }] }],
	['empty', { type: 'list', itemType: 'end', value: [] }],
	[
		'sections',
		{
			type: 'list',
			itemType: 'compound',
			value: [compound([['InhabitedTime', { type: 'long', value: 999n }], ['names', { type: 'list', itemType: 'string', value: [{ type: 'string', value: 'x' }] }]])]
		}
	],
	['nested', compound([['InhabitedTime', { type: 'long', value: 998n }], ['deeper', compound([['x', { type: 'byte', value: 1 }]])]])],
	['ümlaut', { type: 'int', value: 4 }]
];

describe('peekNumber', () => {
	it('finds a number at the top after skipping every kind of tag, and ignores the same name deeper down', () => {
		const data = raw(compound([...everything, ['InhabitedTime', { type: 'long', value: 1234567890123n }]]));
		expect(peekNumber(data, [['InhabitedTime'], ['Level', 'InhabitedTime']])).toBe(1234567890123);
	});

	it('finds one under a compound, as chunks before 1.18 keep it, and reads ints too', () => {
		const data = raw(compound([['Level', compound([...everything, ['InhabitedTime', { type: 'int', value: 42 }]])]]));
		expect(peekNumber(data, [['InhabitedTime'], ['Level', 'InhabitedTime']])).toBe(42);
	});

	it('answers null when the path is missing or holds another type', () => {
		expect(peekNumber(raw(compound(everything)), [['InhabitedTime'], ['Level', 'InhabitedTime']])).toBeNull();
		expect(peekNumber(raw(compound([['InhabitedTime', { type: 'string', value: '5' }]])), [['InhabitedTime']])).toBeNull();
		expect(peekNumber(raw(compound([['Level', { type: 'int', value: 5 }]])), [['Level', 'InhabitedTime']])).toBeNull();
	});

	it('refuses a damaged file instead of reading past it', () => {
		const data = raw(compound([...everything, ['InhabitedTime', { type: 'long', value: 7n }]]));
		expect(() => peekNumber(data.subarray(0, data.length - 6), [['InhabitedTime']])).toThrow(NbtError);
		expect(() => peekNumber(Buffer.from([8, 0, 0]), [['InhabitedTime']])).toThrow(NbtError);
	});
});
