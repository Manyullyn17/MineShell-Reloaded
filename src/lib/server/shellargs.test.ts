import { describe, expect, it } from 'vitest';
import { argsForUnit, shellQuote, splitArgs } from './shellargs';

describe('JVM arguments as typed', () => {
	it('splits on whitespace, quotes grouping as in a shell', () => {
		expect(splitArgs('  -Xmx4G\t-XX:+UseG1GC\n nogui ')).toEqual(['-Xmx4G', '-XX:+UseG1GC', 'nogui']);
		expect(splitArgs(`"-Dmotd=Hello world" -Dname='a b' -Dmixed="a"'b'c`)).toEqual(['-Dmotd=Hello world', '-Dname=a b', '-Dmixed=abc']);
		expect(splitArgs(`'' ""`)).toEqual(['', '']);
	});

	it('keeps backslashes, except before a quote or a backslash', () => {
		expect(splitArgs(`-Dq=\\"x\\" "-Dd=say \\"hi\\" \\\\ C:\\games" '-Ds=\\n'`)).toEqual(['-Dq="x"', '-Dd=say "hi" \\ C:\\games', '-Ds=\\n']);
	});

	it('refuses a quote left open', () => {
		expect(() => splitArgs('-Dx="open')).toThrow(/double quote is not closed/);
		expect(() => splitArgs("-Dx='open")).toThrow(/single quote is not closed/);
		// The unit falls back to spaces for one saved before saving checked.
		expect(argsForUnit('-Xmx2G -Dx="open')).toEqual(['-Xmx2G', '-Dx="open']);
	});

	it('quotes each argument so a shell reads nothing in it', () => {
		const words = ['-Dq=it\'s', '$HOME', '*', 'a;b', '`id`', ''];
		expect(splitArgs(words.map(shellQuote).join(' '))).toEqual(words);
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
	});
});
