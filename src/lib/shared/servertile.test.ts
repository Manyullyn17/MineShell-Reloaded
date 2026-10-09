import { describe, expect, it } from 'vitest';
import { serverHue, serverInitials } from './servertile';

describe('server initials', () => {
	it('takes the first two words, skipping small ones', () => {
		expect(serverInitials('All the Mods 10')).toBe('AM');
		expect(serverInitials('slimes-adventure')).toBe('SA');
		expect(serverInitials('meatballcraft dimensional ascension')).toBe('MD');
		expect(serverInitials('The End')).toBe('E');
	});

	it("uses a single word's capitals, or its first letter", () => {
		expect(serverInitials('MeatballCraft')).toBe('MC');
		expect(serverInitials('irithyll')).toBe('I');
		expect(serverInitials('ATM10')).toBe('AT');
	});

	it('copes with symbols and nothing at all', () => {
		expect(serverInitials('[Test] ✨ server')).toBe('TS');
		expect(serverInitials('   ')).toBe('?');
	});
});

describe('server colour', () => {
	it('is the same for the same name, whatever the case, and spread for others', () => {
		expect(serverHue('ATM10')).toBe(serverHue('atm10'));
		const hues = new Set(['ATM10', 'MeatballCraft', 'slimes-adventure', 'irithyll', 'test', 'vanilla'].map(serverHue));
		expect(hues.size).toBe(6);
		for (const h of hues) expect(h).toBeGreaterThanOrEqual(0);
	});
});
