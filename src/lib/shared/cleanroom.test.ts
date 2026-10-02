import { describe, expect, it } from 'vitest';
import { canUseCleanroom, cleanroomJavaMajor } from './cleanroom';

describe('cleanroomJavaMajor', () => {
	// Measured from the class-file version of every release jar: the split is
	// between 0.4.4-alpha and 0.5.0-alpha.
	it.each([
		['0.3.16-alpha', 21],
		['0.4.0', 21],
		['0.4.4-alpha', 21],
		['0.5.0-alpha', 25],
		['0.5.17-alpha', 25],
		['0.6.13-alpha', 25]
	])('%s needs Java %i', (version, java) => {
		expect(cleanroomJavaMajor(version)).toBe(java);
	});

	it('assumes the latest (Java 25) when no version is known', () => {
		expect(cleanroomJavaMajor(null)).toBe(25);
		expect(cleanroomJavaMajor(undefined)).toBe(25);
	});
});

describe('canUseCleanroom', () => {
	it('only replaces Forge on 1.12.2', () => {
		expect(canUseCleanroom('forge', '1.12.2')).toBe(true);
		expect(canUseCleanroom('forge', '1.12')).toBe(false);
		expect(canUseCleanroom('forge', '1.16.5')).toBe(false);
		expect(canUseCleanroom('neoforge', '1.12.2')).toBe(false);
		expect(canUseCleanroom('fabric', '1.12.2')).toBe(false);
	});
});
