import { describe, expect, it } from 'vitest';
import { acceptableJavaMajors, compareVersions, requiredJavaMajor } from './java';

describe('compareVersions', () => {
	it('compares numerically, not as text', () => {
		expect(compareVersions('1.12.2', '1.12')).toBeGreaterThan(0);
		expect(compareVersions('1.20.5', '1.20.10')).toBeLessThan(0);
		expect(compareVersions('1.21', '1.21.0')).toBe(0);
		expect(compareVersions('0.23.3', '0.23.4')).toBeLessThan(0);
	});
});

describe('requiredJavaMajor', () => {
	it.each([
		['1.12.2', 8],
		['1.16.5', 8],
		['1.17.1', 16],
		['1.18.2', 17],
		['1.20.4', 17],
		['1.20.5', 21],
		['1.21.1', 21]
	])('Minecraft %s needs Java %i', (mc, java) => {
		expect(requiredJavaMajor(mc)).toBe(java);
	});

	it('follows the Cleanroom version instead of Minecraft 1.12.2', () => {
		expect(requiredJavaMajor('1.12.2', 'cleanroom', '0.4.4-alpha')).toBe(21);
		expect(requiredJavaMajor('1.12.2', 'cleanroom', '0.5.17-alpha')).toBe(25);
		expect(requiredJavaMajor('1.12.2', 'forge', '14.23.5.2860')).toBe(8);
	});
});

describe('acceptableJavaMajors', () => {
	it('keeps legacy Forge on exactly Java 8', () => {
		expect(acceptableJavaMajors('1.12.2', 'forge')).toEqual([8]);
		expect(acceptableJavaMajors('1.16.5', 'fabric')).toContain(17);
	});

	it('never offers Cleanroom 0.5+ anything older than Java 25', () => {
		expect(Math.min(...acceptableJavaMajors('1.12.2', 'cleanroom', '0.5.0-alpha'))).toBe(25);
		expect(acceptableJavaMajors('1.12.2', 'cleanroom', '0.4.4-alpha')).toContain(21);
	});
});
