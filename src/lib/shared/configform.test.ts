import { describe, expect, it } from 'vitest';
import { checkField, configFormatOf, ConfigFormError, readConfig, whenApplied, writeField, type ConfigField, type ConfigFormat } from './configform';

function fields(format: ConfigFormat, text: string): ConfigField[] {
	return readConfig(format, text).sections.flatMap((s) => s.fields);
}
function field(format: ConfigFormat, text: string, key: string): ConfigField {
	const found = fields(format, text).find((f) => f.key === key);
	if (!found) throw new Error(`no ${key}`);
	return found;
}
function edit(format: ConfigFormat, text: string, key: string, input: boolean | string | string[]): string {
	return writeField(text, format, field(format, text, key), input);
}

describe('configFormatOf', () => {
	it('knows the formats the form reads', () => {
		expect(configFormatOf('config/create-common.toml')).toBe('toml');
		expect(configFormatOf('config/Mekanism.cfg')).toBe('forgecfg');
		expect(configFormatOf('config/yacl.json5')).toBe('json');
		expect(configFormatOf('config/a.JSON')).toBe('json');
		expect(configFormatOf('config/ftbchunks-world.snbt')).toBeNull();
	});
});

const NEOFORGE = `#.
#Modify Create's impact on your terrain
[worldgen]
	#.
	#Prevents all worldgen added by Create from taking effect
	disableWorldGen = false

[crafting]
	#Number of ticks between two crystal growth accelerator ticks
	# Default: 10
	# Range: 1 ~ 100
	growthAccelerator = 10
	# Default: 128
	# Range: > -2147483648
	formationPlaneEntityLimit = 128
	#Allowed Values: INFINITE, DEFAULT, X2
	channels = "DEFAULT"
	creativeCapacity = 9223372036854775807
	ratio = 1.6E7
	literal = 'C:\\path'
	items = ["minecraft:stone", "minecraft:dirt"]
	long = [
		"a",
		"b"
	]
	commented = [
		# keep me
		"a"
	]
	"quoted.key" = 1 # trailing

[[rules]]
	name = "first"
[[rules]]
	name = "second"
`;

describe('NeoForge/Forge TOML', () => {
	it('reads sections, hints and the limits in the comments', () => {
		const parsed = readConfig('toml', NEOFORGE);
		expect(parsed.sections.map((s) => s.title)).toEqual(['worldgen', 'crafting', 'rules (1)', 'rules (2)']);
		expect(parsed.sections[0].hint).toBe("Modify Create's impact on your terrain");
		const growth = field('toml', NEOFORGE, 'growthAccelerator');
		expect(growth).toMatchObject({ kind: 'integer', value: '10', min: 1, max: 100, defaultText: '10', hint: 'Number of ticks between two crystal growth accelerator ticks' });
		expect(field('toml', NEOFORGE, 'formationPlaneEntityLimit')).toMatchObject({ min: -2147483648 });
		expect(field('toml', NEOFORGE, 'formationPlaneEntityLimit').max).toBeUndefined();
		expect(field('toml', NEOFORGE, 'channels')).toMatchObject({ kind: 'string', choices: ['INFINITE', 'DEFAULT', 'X2'] });
		expect(field('toml', NEOFORGE, 'disableWorldGen')).toMatchObject({ kind: 'boolean', value: false, hint: 'Prevents all worldgen added by Create from taking effect' });
		expect(field('toml', NEOFORGE, 'quoted.key')).toMatchObject({ kind: 'integer', value: '1' });
		expect(field('toml', NEOFORGE, 'items')).toMatchObject({ kind: 'list', items: 'string', value: ['minecraft:stone', 'minecraft:dirt'] });
		// Two tables of one name are two sections, their settings apart.
		expect(parsed.sections[2].fields[0].id).not.toBe(parsed.sections[3].fields[0].id);
	});

	it('reads longs past what a JS number holds, as written', () => {
		expect(field('toml', NEOFORGE, 'creativeCapacity')).toMatchObject({ kind: 'integer', value: '9223372036854775807' });
	});

	it('changes only the value, comments and layout as they were', () => {
		const out = edit('toml', NEOFORGE, 'growthAccelerator', '25');
		expect(out).toBe(NEOFORGE.replace('growthAccelerator = 10', 'growthAccelerator = 25'));
		expect(edit('toml', NEOFORGE, 'disableWorldGen', true)).toBe(NEOFORGE.replace('disableWorldGen = false', 'disableWorldGen = true'));
		expect(edit('toml', NEOFORGE, 'quoted.key', '2')).toContain('"quoted.key" = 2 # trailing');
	});

	it('keeps a float a float and a literal string literal', () => {
		expect(edit('toml', NEOFORGE, 'ratio', '3')).toContain('ratio = 3.0\n');
		expect(edit('toml', NEOFORGE, 'ratio', '2.5E8')).toContain('ratio = 2.5E8\n');
		expect(edit('toml', NEOFORGE, 'literal', 'D:\\other')).toContain("literal = 'D:\\other'\n");
		expect(edit('toml', NEOFORGE, 'literal', "it's")).toContain('literal = "it\'s"\n');
		expect(edit('toml', NEOFORGE, 'channels', 'say "hi"')).toContain('channels = "say \\"hi\\""\n');
	});

	it('writes a list in the shape it had', () => {
		expect(edit('toml', NEOFORGE, 'items', ['minecraft:sand'])).toContain('items = ["minecraft:sand"]\n');
		expect(edit('toml', NEOFORGE, 'long', ['a', 'b', 'c'])).toContain('long = [\n\t\t"a",\n\t\t"b",\n\t\t"c"\n\t]\n');
		expect(edit('toml', NEOFORGE, 'items', [])).toContain('items = []\n');
	});

	it('leaves a list with comments in it as text, so they stay', () => {
		const commented = field('toml', NEOFORGE, 'commented');
		expect(commented.kind).toBe('raw');
		expect(commented.value).toBe('[\n\t\t# keep me\n\t\t"a"\n\t]');
	});

	it('changes nothing when the value is the same', () => {
		expect(edit('toml', NEOFORGE, 'ratio', '1.6E7')).toBe(NEOFORGE);
	});

	it('refuses a file that is not valid TOML, naming the line', () => {
		expect(() => readConfig('toml', 'a = 1\nb = = 2\n')).toThrow(ConfigFormError);
		try {
			readConfig('toml', 'a = 1\nb = = 2\n');
		} catch (err) {
			expect((err as ConfigFormError).line).toBe(2);
		}
	});
});

const FORGE_1_12 = `# Configuration file

~CONFIG_VERSION: 1

##########################################################################################################
# general
#--------------------------------------------------------------------------------------------------------#
# The main settings
##########################################################################################################

general {
    # How far it reaches [range: 1 ~ 64, default: 16]
    I:range=16

    # Whether it works at all [default: true]
    B:enabled=true

    # How it repairs
    # Valid values:
    # KEEP
    # REMOVE
    S:"Repair mode"=KEEP

    S:"Key with = in it"=a=b
    D:ratio=1.5

    S:"Mod Aliases" <
        incorporeal=botania
        animus=bloodmagic
     >

    S:empty <
     >

    "client settings" {
        I:count=3
    }

}
`;

describe('Forge 1.12 .cfg', () => {
	it('reads categories, typed settings and the limits in the comments', () => {
		const parsed = readConfig('forgecfg', FORGE_1_12);
		expect(parsed.sections.map((s) => s.title)).toEqual(['general', 'general › client settings']);
		expect(parsed.sections[0].hint).toBe('The main settings');
		expect(field('forgecfg', FORGE_1_12, 'range')).toMatchObject({ kind: 'integer', value: '16', min: 1, max: 64, defaultText: '16', hint: 'How far it reaches' });
		expect(field('forgecfg', FORGE_1_12, 'enabled')).toMatchObject({ kind: 'boolean', value: true, defaultText: 'true', hint: 'Whether it works at all' });
		expect(field('forgecfg', FORGE_1_12, 'Repair mode')).toMatchObject({ kind: 'string', choices: ['KEEP', 'REMOVE'], hint: 'How it repairs' });
		expect(field('forgecfg', FORGE_1_12, 'Key with = in it')).toMatchObject({ value: 'a=b' });
		expect(field('forgecfg', FORGE_1_12, 'Mod Aliases')).toMatchObject({ kind: 'list', items: 'string', value: ['incorporeal=botania', 'animus=bloodmagic'] });
		expect(field('forgecfg', FORGE_1_12, 'count')).toMatchObject({ kind: 'integer', value: '3' });
	});

	it('changes only the value', () => {
		expect(edit('forgecfg', FORGE_1_12, 'range', '32')).toBe(FORGE_1_12.replace('I:range=16', 'I:range=32'));
		expect(edit('forgecfg', FORGE_1_12, 'Key with = in it', 'c')).toBe(FORGE_1_12.replace('"Key with = in it"=a=b', '"Key with = in it"=c'));
		expect(edit('forgecfg', FORGE_1_12, 'enabled', false)).toContain('    B:enabled=false\n');
	});

	it('writes a list one item a line, at the indent it had', () => {
		expect(edit('forgecfg', FORGE_1_12, 'Mod Aliases', ['a=b'])).toContain('    S:"Mod Aliases" <\n        a=b\n     >\n');
		expect(edit('forgecfg', FORGE_1_12, 'empty', ['x', 'y'])).toContain('    S:empty <\n        x\n        y\n     >\n');
	});

	it('refuses a .cfg that is not in Forge’s format', () => {
		expect(() => readConfig('forgecfg', 'just some text\n')).toThrow(ConfigFormError);
		expect(() => readConfig('forgecfg', 'general {\n    I:a=1\n')).toThrow(/not closed/);
	});
});

const JSON5_TEXT = `{
	// Show the hint
	showHint: true,
	"limit": 64, // not the next one's
	"ratio": 16.0,
	"name": "Ender's",
	/* Where it goes */
	"tags": [
		"a",
		"b"
	],
	"rules": [{ "a": 1 }],
	"nested": {
		// Inner
		"deep": 1
	},
	"after": null
}
`;

describe('JSON and JSON5', () => {
	it('reads keys with their comments, and nested objects as sections', () => {
		const parsed = readConfig('json', JSON5_TEXT);
		expect(parsed.sections.map((s) => s.title)).toEqual(['General', 'nested']);
		expect(field('json', JSON5_TEXT, 'showHint')).toMatchObject({ kind: 'boolean', value: true, hint: 'Show the hint' });
		expect(field('json', JSON5_TEXT, 'limit')).toMatchObject({ kind: 'integer', value: '64', hint: '' });
		// A comment after a value on its line is that value's, not the next key's.
		expect(field('json', JSON5_TEXT, 'ratio')).toMatchObject({ kind: 'float', value: '16.0', hint: '' });
		expect(field('json', JSON5_TEXT, 'tags')).toMatchObject({ kind: 'list', value: ['a', 'b'], hint: 'Where it goes' });
		expect(field('json', JSON5_TEXT, 'rules')).toMatchObject({ kind: 'raw', value: '[{ "a": 1 }]' });
		expect(field('json', JSON5_TEXT, 'deep')).toMatchObject({ kind: 'integer', hint: 'Inner' });
		expect(field('json', JSON5_TEXT, 'after')).toMatchObject({ kind: 'raw', value: 'null' });
	});

	it('changes only the value', () => {
		expect(edit('json', JSON5_TEXT, 'showHint', false)).toBe(JSON5_TEXT.replace('showHint: true', 'showHint: false'));
		expect(edit('json', JSON5_TEXT, 'name', 'a "b"')).toContain('"name": "a \\"b\\"",');
		expect(edit('json', JSON5_TEXT, 'tags', ['c'])).toContain('"tags": [\n\t\t"c"\n\t],');
		expect(edit('json', JSON5_TEXT, 'ratio', '+2')).toContain('"ratio": 2,');
	});

	it('refuses a file that is a list or no JSON at all', () => {
		expect(() => readConfig('json', '["a", "b"]')).toThrow(/list/);
		expect(() => readConfig('json', '{"a": }')).toThrow(ConfigFormError);
		expect(() => readConfig('json', '{}')).toThrow(/no settings/);
	});
});

describe('checkField', () => {
	const growth = field('toml', NEOFORGE, 'growthAccelerator');
	it('holds numbers to their kind and range', () => {
		expect(checkField('toml', growth, '50')).toBeNull();
		expect(checkField('toml', growth, '0')).toBe('It has to be from 1 to 100.');
		expect(checkField('toml', growth, '1.5')).toBe('"1.5" is not a whole number.');
		expect(checkField('toml', field('toml', NEOFORGE, 'formationPlaneEntityLimit'), '-2147483649')).toBe('It has to be at least -2147483648.');
		expect(checkField('toml', field('toml', NEOFORGE, 'ratio'), 'abc')).toBe('"abc" is not a number.');
	});

	it('holds a setting with choices to them', () => {
		expect(checkField('toml', field('toml', NEOFORGE, 'channels'), 'X2')).toBeNull();
		expect(checkField('toml', field('toml', NEOFORGE, 'channels'), 'X9')).toMatch(/one of INFINITE, DEFAULT, X2/);
	});

	it('refuses what would break the file', () => {
		expect(checkField('forgecfg', field('forgecfg', FORGE_1_12, 'Key with = in it'), 'two\nlines')).toBe('It has to be one line.');
		expect(checkField('forgecfg', field('forgecfg', FORGE_1_12, 'Mod Aliases'), ['a', '>'])).toMatch(/">"/);
		expect(checkField('toml', field('toml', NEOFORGE, 'commented'), '[1, ')).toBe('That is not a TOML value.');
		expect(checkField('json', field('json', JSON5_TEXT, 'rules'), '[{"a": 2}]')).toBeNull();
	});
});

describe('whenApplied', () => {
	it('says Forge and NeoForge read their own configs again, the rest at start', () => {
		expect(whenApplied('config/create-common.toml', 'neoforge')).toMatch(/^NeoForge reads this file again/);
		expect(whenApplied('world/serverconfig/create-server.toml', 'forge')).toMatch(/^Forge reads/);
		expect(whenApplied('config/create-client.toml', 'neoforge')).toMatch(/^A client config: NeoForge does not load it on a server/);
		expect(whenApplied('config/create-client.toml', 'fabric')).toMatch(/server starts/);
		expect(whenApplied('config/Mekanism.cfg', 'cleanroom')).toMatch(/server starts/);
		expect(whenApplied('defaultconfigs/create-server.toml', 'neoforge')).toMatch(/only when the world is created/);
	});
});
