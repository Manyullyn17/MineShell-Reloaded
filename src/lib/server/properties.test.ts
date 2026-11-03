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
	propertyNote,
	readProperties,
	serialiseProperties,
	usesNamespacedLevelType,
	withFieldDefaults
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

	// The first version whose server jar has the key (every release of 1.16, 1.18 and 1.19 checked).
	it.each([
		['enable-status', '1.15.2', '1.16'],
		['rate-limit', '1.16.1', '1.16.2'],
		['hide-online-players', '1.17.1', '1.18'],
		['enforce-secure-profile', '1.18.2', '1.19'],
		['initial-enabled-packs', '1.19.2', '1.19.3'],
		['log-ips', '1.20.1', '1.20.2'],
		['accepts-transfers', '1.20.4', '1.20.5'],
		['region-file-compression', '1.20.4', '1.20.5'],
		['chat-spam-threshold-seconds', '26.1.2', '26.2'],
		['generator-settings', '1.3.2', '1.4.2']
	])('offers %s from the version that reads it (not %s, from %s)', (key, before, since) => {
		const has = (version: string) => fieldsForVersion(PROPERTY_SCHEMA, version).some((f) => f.key === key);
		expect([has(before), has(since), has('26.3'), has('')]).toEqual([false, true, true, true]);
	});

	it("shows Minecraft's own value for a key the file does not have yet, and the file's when it has one", () => {
		const fields = fieldsForVersion(PROPERTY_SCHEMA, '1.21.11');
		const values = withFieldDefaults({ 'enable-status': 'false', motd: 'Hi' }, fields);
		expect(values).toMatchObject({ 'enable-status': 'false', 'enforce-secure-profile': 'true', 'log-ips': 'true', 'rate-limit': '0', 'region-file-compression': 'deflate', 'initial-enabled-packs': 'vanilla', 'generate-structures': 'true', motd: 'Hi' });
		// A field without one stays absent, and fields the version lacks add nothing.
		expect(values).not.toHaveProperty('generator-settings');
		expect(values).not.toHaveProperty('chat-spam-threshold-seconds');
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

describe('keys without a control', () => {
	// Every key in the files vanilla 1.21.11 and 26.3 wrote, and the older ones the server jars read back to 1.2.5.
	const NEWEST = `accepts-transfers allow-flight broadcast-console-to-ops broadcast-rcon-to-ops bug-report-link chat-spam-threshold-seconds
		command-spam-threshold-seconds difficulty enable-code-of-conduct enable-jmx-monitoring enable-query enable-rcon enable-status enforce-secure-profile
		enforce-whitelist entity-broadcast-range-percentage force-gamemode function-permission-level gamemode generate-structures generator-settings hardcore
		hide-online-players initial-disabled-packs initial-enabled-packs level-name level-seed level-type log-ips management-server-allowed-origins
		management-server-enabled management-server-host management-server-port management-server-secret management-server-tls-enabled
		management-server-tls-keystore management-server-tls-keystore-password max-chained-neighbor-updates max-players max-tick-time max-world-size motd
		network-compression-threshold online-mode op-permission-level pause-when-empty-seconds player-idle-timeout prevent-proxy-connections query.port
		rate-limit rcon.password rcon.port region-file-compression require-resource-pack resource-pack resource-pack-id resource-pack-prompt
		resource-pack-sha1 server-ip server-port simulation-distance spawn-protection status-heartbeat-interval sync-chunk-writes text-filtering-config
		text-filtering-version use-native-transport view-distance white-list`;
	const OLDER = `allow-nether announce-player-achievements enable-command-block max-build-height previews-chat pvp resource-pack-hash snooper-enabled
		spawn-animals spawn-monsters spawn-npcs texture-pack`;
	// Kept by MineShell (settings page MANAGED_KEYS), with controls of their own elsewhere.
	const MANAGED = new Set(['rcon.password', 'rcon.port', 'enable-rcon', 'server-port', 'query.port']);

	it("are all Minecraft's own with a note, so a key without one is a mod's", () => {
		const keys = `${NEWEST} ${OLDER}`.split(/\s+/).filter(Boolean);
		const withControl = new Set(PROPERTY_SCHEMA.map((f) => f.key));
		const unexplained = keys.filter((k) => !withControl.has(k) && !MANAGED.has(k) && !propertyNote(k).vanilla);
		expect(unexplained).toEqual([]);
		expect(propertyNote('management-server-secret').note).toMatch(/operators/);
		expect(propertyNote('some-mod-setting')).toEqual({ note: expect.stringMatching(/a mod's or the pack's/), vanilla: false });
	});
});
