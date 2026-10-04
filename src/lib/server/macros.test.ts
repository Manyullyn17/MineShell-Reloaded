import { describe, expect, it } from 'vitest';
import { deleteMacros, getMacros, MAX_MACROS, setMacros } from './macros';

describe('console macros', () => {
	it('keeps commands in order, trimmed, without duplicates or line breaks', () => {
		expect(setMacros('macro-a', ['say Restart in 5 minutes', '  list ', 'list', 'say two\nlines', 7, ''])).toEqual([
			'say Restart in 5 minutes',
			'list',
			'say two lines'
		]);
		expect(getMacros('macro-a')).toEqual(['say Restart in 5 minutes', 'list', 'say two lines']);
		expect(getMacros('macro-b')).toEqual([]);
	});

	it('caps the count and length, and forgets them with the server', () => {
		setMacros('macro-c', Array.from({ length: 30 }, (_, i) => `say ${i} ${'x'.repeat(300)}`));
		const saved = getMacros('macro-c');
		expect(saved).toHaveLength(MAX_MACROS);
		expect(saved.every((m) => m.length === 200)).toBe(true);
		deleteMacros('macro-c');
		expect(getMacros('macro-c')).toEqual([]);
		expect(setMacros('macro-d', 'not a list')).toEqual([]);
	});
});
