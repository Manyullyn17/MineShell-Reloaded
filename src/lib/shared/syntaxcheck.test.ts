import { describe, expect, it } from 'vitest';
import { languageOf, syntaxProblem } from './syntaxcheck';

describe('syntax check', () => {
	it('knows the kinds by extension', () => {
		expect(['a.json', 'pack.mcmeta', 'b.json5', 'c.toml', 'd.yml', 'server.properties', 'forge.cfg', 'kubejs/x.js', 'run.sh', 'readme.txt', 'noext'].map(languageOf)).toEqual([
			'json', 'json', 'json5', 'toml', 'yaml', 'properties', 'forgecfg', 'javascript', 'shell', null, null
		]);
	});

	it('names the line of a missing comma in JSON, and of one cut short', async () => {
		expect(await syntaxProblem('json', '{\n  "a": 1\n  "b": 2\n}')).toEqual({ line: 3, message: expect.stringMatching(/Expected ','/) });
		expect(await syntaxProblem('json', '{\n  "a": [1, 2\n')).toMatchObject({ line: 3 });
		expect(await syntaxProblem('json', '{ "a": 1 }')).toBeNull();
	});

	it("finds the line from Firefox's and Safari's wording too", async () => {
		const text = '{\n  "a": 1\n  "b": 2\n}';
		const parse = JSON.parse;
		try {
			JSON.parse = () => {
				throw new SyntaxError("JSON.parse: expected ',' or '}' after property value in object at line 3 column 3 of the JSON data");
			};
			expect(await syntaxProblem('json', text)).toEqual({ line: 3, message: "Expected ',' or '}' after property value" });
			JSON.parse = () => {
				throw new SyntaxError("JSON Parse error: Expected '}'");
			};
			expect(await syntaxProblem('json', text)).toMatchObject({ line: 3 });
		} finally {
			JSON.parse = parse;
		}
	});

	it('reads JSON5 with comments, and names its errors', async () => {
		expect(await syntaxProblem('json5', '// options\n{ a: 1, }')).toBeNull();
		expect(await syntaxProblem('json5', '{\n  a: 1\n  b: 2\n}')).toMatchObject({ line: 3 });
	});

	it('names the line of a TOML or YAML error', async () => {
		expect(await syntaxProblem('toml', '[general]\nenabled = true\nlimit = \n')).toMatchObject({ line: 3 });
		expect(await syntaxProblem('toml', '# c\n[general]\nenabled = true\n')).toBeNull();
		expect(await syntaxProblem('yaml', 'a: 1\nb:\n  - x\n - y\n')).toMatchObject({ line: 4 });
		expect(await syntaxProblem('yaml', 'a: 1\nb: [x, y]\n')).toBeNull();
	});

	it('does not check what has no syntax to break', async () => {
		expect(await syntaxProblem('properties', 'motd=}{')).toBeNull();
		expect(await syntaxProblem(null, '{')).toBeNull();
		expect(await syntaxProblem('json', '   \n')).toBeNull();
	});
});
