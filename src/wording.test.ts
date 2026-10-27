import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plural } from '#lib/shared/format.js';

/**
 * Messages count things in words that fit the number ("1 file", "3 files"; `plural` in
 * format.ts), not "3 file(s)". Found in the text of every page and server module; comments
 * may say what they like, and code like `keep(s);` is told apart by what follows it.
 */
const PARENTHESISED_PLURAL = /\b[a-z]+\((?:s|es)\)(?= [a-z]|[`'"]|; [a-z])/;

describe('counts in messages', () => {
	it('plural() fits the noun to the number', () => {
		expect(plural(1, 'file')).toBe('1 file');
		expect(plural(0, 'file')).toBe('0 files');
		expect(plural(3, 'config file was', 'config files were')).toBe('3 config files were');
	});

	const files = fs.globSync(['src/**/*.ts', 'src/**/*.svelte']).filter((f) => !f.endsWith('.test.ts'));

	it.each(files)('no "word(s)" in %s', (file) => {
		const found = fs
			.readFileSync(file, 'utf8')
			.split('\n')
			.map((line, i) => [i + 1, line] as const)
			.filter(([, line]) => !/^\s*(\*|\/\/|\/\*)/.test(line) && PARENTHESISED_PLURAL.test(line))
			.map(([n]) => `${file}:${n}`);
		expect(found).toEqual([]);
	});
});
