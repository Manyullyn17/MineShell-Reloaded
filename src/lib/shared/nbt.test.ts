import { describe, expect, it } from 'vitest';
import { childMatches, countMatches, selfMatches, type TreeTag } from './nbt';

const tree: TreeTag = {
	type: 'compound',
	value: [
		['Health', { type: 'float', value: 20 }],
		['ManaData', { type: 'compound', value: [['mana', { type: 'float', value: 120 }]] }],
		['Tags', { type: 'list', itemType: 'string', value: [{ type: 'string', value: 'vip' }, { type: 'string', value: 'mana-user' }] }],
		['Pos', { type: 'list', itemType: 'double', value: [{ type: 'double', value: 1 }, { type: 'double', value: 64 }] }]
	]
};

describe('searching the tree', () => {
	it('matches keys and values, anywhere down, case-insensitively', () => {
		expect(countMatches(tree, 'mana')).toBe(3); // ManaData, mana, "mana-user"
		expect(countMatches(tree, '120')).toBe(1);
		expect(childMatches(tree.value[1][1] as TreeTag, 'mana')).toBe(true);
		expect(selfMatches('Health', { type: 'float', value: 20 }, 'health')).toBe(true);
	});

	it('does not match list positions as keys', () => {
		// "1" is Pos[0]'s value, not every list's entry number 1.
		expect(countMatches(tree, '1')).toBe(2); // 120 and the 1 in Pos
		expect(selfMatches(null, { type: 'double', value: 64 }, '1')).toBe(false);
	});
});
