import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	choiceValueFor,
	defaultProperties,
	fieldForVersion,
	fieldsForVersion,
	fillPropertyDefaults,
	levelTypeOptionsFor,
	matchPropertiesToVersion,
	movedGameRules,
	parseProperties,
	PROPERTY_SCHEMA,
	patchProperties,
	readProperties,
	serialiseProperties,
	usesNamespacedLevelType
} from './properties';
import { tempDir } from '../../../tests/helpers/fs';

describe('parseProperties', () => {
	it('reads key=value lines, skipping comments and blanks', () => {
		const { values } = parseProperties('#comment\n!also comment\n\nmotd=Hello = World\nserver-port=25565\n  pvp=true  \n');
		expect(values).toEqual({ motd: 'Hello = World', 'server-port': '25565', pvp: 'true' });
	});

	it('lists keys MineShell has no field for', () => {
		expect(parseProperties('server-port=1\nsome-mod-key=x\n').extraKeys).toEqual(['some-mod-key']);
	});

	it('round-trips through serialise', () => {
		const values = { motd: 'A', 'server-port': '25565', 'level-seed': '' };
		expect(parseProperties(serialiseProperties(values)).values).toEqual(values);
	});

	it('reads the escapes Minecraft writes', () => {
		// As 1.12.2 and 1.21.11 wrote back `motd=Gemütlich Server: home! C:\\games` (UTF-8):
		// 1.12.2 had read the file as Latin-1.
		expect(parseProperties('motd=Gem\\u00C3\\u00BCtlich Server\\: home\\! C\\:\\\\games\n').values.motd).toBe('GemÃ¼tlich Server: home! C:\\games');
		expect(parseProperties('motd=Gemütlich Server\\: home\\! C\\:\\\\games\nlevel-name=My\\: World\n').values).toEqual({ motd: 'Gemütlich Server: home! C:\\games', 'level-name': 'My: World' });
		expect(parseProperties('motd=one \\\n    two\nkey\\ with\\=odd: value\r\n').values).toEqual({ motd: 'one two', 'key with=odd': 'value' });
	});

	it('writes what every Minecraft reads back the same: past ASCII escaped, backslashes doubled', () => {
		const values = { motd: ' Gemütlich: home! C:\\games 🎮 #1 = best', 'level-name': 'world' };
		const text = serialiseProperties(values);
		expect(text).toContain('motd=\\ Gem\\u00FCtlich: home! C:\\\\games \\uD83C\\uDFAE #1 = best\n');
		expect(text).not.toMatch(/[^\x00-\x7e]/);
		expect(parseProperties(text).values).toEqual(values);
		// The raw editor shows the letters themselves; either way reads back the same.
		const shown = serialiseProperties(values, { unicode: true });
		expect(shown).toContain('Gemütlich');
		expect(parseProperties(shown).values).toEqual(values);
	});
});

describe('server.properties on disk', () => {
	it('patches without dropping unknown keys', async () => {
		const dir = await tempDir();
		await fs.writeFile(path.join(dir, 'server.properties'), 'server-port=1\nmod-specific=keep\n');
		await patchProperties(dir, { 'server-port': '25570' });
		expect((await readProperties(dir)).values).toEqual({ 'server-port': '25570', 'mod-specific': 'keep' });
	});

	it("fills only missing keys, so a pack's own choices win", async () => {
		const dir = await tempDir();
		await fs.writeFile(path.join(dir, 'server.properties'), 'difficulty=hard\n');
		const defaults = defaultProperties({ port: 25565, rconPort: 25575, rconPassword: 'pw', motd: 'M', minecraftVersion: '1.20.1' });
		const merged = await fillPropertyDefaults(dir, defaults);
		expect(merged.difficulty).toBe('hard');
		expect(merged['server-port']).toBe('25565');
	});

	it('reads a missing file as empty', async () => {
		expect(await readProperties(await tempDir())).toEqual({ values: {}, extraKeys: [] });
	});
});

describe('level types', () => {
	it('uses namespaced values from 1.19 and legacy ones before', () => {
		expect(usesNamespacedLevelType('1.19')).toBe(true);
		expect(usesNamespacedLevelType('1.18.2')).toBe(false);
		expect(defaultProperties({ port: 1, rconPort: 2, rconPassword: '', motd: '', minecraftVersion: '1.12.2' })['level-type']).toBe('DEFAULT');
		expect(defaultProperties({ port: 1, rconPort: 2, rconPassword: '', motd: '', minecraftVersion: '1.20.1' })['level-type']).toBe('minecraft:normal');
		expect(levelTypeOptionsFor('1.12.2').map((o) => o.value)).toContain('FLAT');
		expect(levelTypeOptionsFor('1.21').map((o) => o.value)).toContain('minecraft:flat');
	});
});

describe('fields by Minecraft version', () => {
	const pause = (version: string) => fieldsForVersion(PROPERTY_SCHEMA, version).some((f) => f.key === 'pause-when-empty-seconds');

	it('offers pausing an empty server from 1.21.2 on, and every field when the version is unknown', () => {
		expect(pause('1.21.1')).toBe(false);
		expect(pause('1.12.2')).toBe(false);
		expect(pause('1.21.2')).toBe(true);
		expect(pause('1.21.11')).toBe(true);
		expect(pause('26.1')).toBe(true);
		expect(pause('')).toBe(true);
	});

	it('offers PvP, the Nether, monsters and command blocks up to 1.21.8, which they became game rules after', () => {
		const moved = ['pvp', 'allow-nether', 'spawn-monsters', 'enable-command-block'];
		const keys = (version: string) => fieldsForVersion(PROPERTY_SCHEMA, version).map((f) => f.key);
		for (const version of ['1.12.2', '1.21.8', '']) expect(keys(version)).toEqual(expect.arrayContaining(moved));
		for (const version of ['1.21.9', '1.21.11', '26.3']) for (const key of moved) expect(keys(version)).not.toContain(key);
		expect(movedGameRules('1.21.8')).toBeNull();
		expect(movedGameRules('1.21.10')).toEqual(['pvp', 'spawnMonsters', 'allowEnteringNetherUsingPortals', 'commandBlocksEnabled']);
		expect(movedGameRules('26.3')).toEqual(['pvp', 'spawn_monsters', 'allow_entering_nether_using_portals', 'command_blocks_work']);
	});
});

describe('difficulty and game mode', () => {
	// 1.12.2 read difficulty=hard as Easy and wrote back difficulty=1 (mc-probe.mjs).
	it('are numbers before 1.14 and names from it, whichever the file holds', () => {
		expect(choiceValueFor('difficulty', 'hard', '1.12.2')).toBe('3');
		expect(choiceValueFor('gamemode', 'creative', '1.13.2')).toBe('1');
		expect(choiceValueFor('difficulty', '2', '1.12.2')).toBe('2');
		expect(choiceValueFor('difficulty', '3', '1.14')).toBe('hard');
		expect(choiceValueFor('gamemode', 'Survival', '26.3')).toBe('survival');
		expect(choiceValueFor('difficulty', 'normal', '')).toBe('normal');
		// Not one of them: left as it is.
		expect(choiceValueFor('difficulty', 'nightmare', '1.12.2')).toBe('nightmare');
		expect(choiceValueFor('max-players', '3', '1.12.2')).toBe('3');
		const difficulty = PROPERTY_SCHEMA.find((f) => f.key === 'difficulty')!;
		expect(fieldForVersion(difficulty, '1.7.10').options).toEqual([
			{ value: '0', label: 'Peaceful' },
			{ value: '1', label: 'Easy' },
			{ value: '2', label: 'Normal' },
			{ value: '3', label: 'Hard' }
		]);
		expect(fieldForVersion(difficulty, '1.21.1').options?.map((o) => o.value)).toEqual(['peaceful', 'easy', 'normal', 'hard']);
	});

	it('are rewritten as numbers before a server older than 1.14 starts, and the file is otherwise left alone', async () => {
		const dir = await tempDir();
		const file = path.join(dir, 'server.properties');
		await fs.writeFile(file, 'difficulty=normal\ngamemode=creative\nmotd=Hi\n');
		await matchPropertiesToVersion(dir, '1.12.2');
		expect((await readProperties(dir)).values).toEqual({ difficulty: '2', gamemode: '1', motd: 'Hi' });

		await fs.writeFile(file, 'difficulty=2\nmotd=Hi\n');
		await matchPropertiesToVersion(dir, '1.12.2');
		expect(await fs.readFile(file, 'utf8')).toBe('difficulty=2\nmotd=Hi\n');
	});
});
