import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	defaultProperties,
	fillPropertyDefaults,
	levelTypeOptionsFor,
	parseProperties,
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
