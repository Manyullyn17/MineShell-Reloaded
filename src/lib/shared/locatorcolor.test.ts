import { describe, expect, it } from 'vitest';
import { locatorColor } from './locatorcolor';

// Printed by the 26.3 client's own net.minecraft.util.ARGB, as LocatorBar calls it.
const GAME = {
	'069a79f4-44e9-4726-a5be-fca90e38aaf5': '#e66185',
	'5627dd98-e6be-3c21-b8a8-e92344183641': '#2b41e6',
	'00000000-0000-4000-8000-000000000000': '#00e600',
	'853c80ef-3c37-49fd-aa49-938b674adae6': '#0ee6e4',
	'ffffffff-ffff-4fff-bfff-ffffffffffff': '#00e600',
	'00000000-0000-0000-0000-000000000000': '#e6e6e6',
	Steve: '#c9e6b5',
	Manyullyn: '#e6ae65'
};

describe('locator bar colour', () => {
	it.each(Object.entries(GAME))('%s is %s, as in the game', (id, colour) => {
		expect(locatorColor(id)).toBe(colour);
	});
});
