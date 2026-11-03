import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Tag } from '#lib/server/nbt.js';

const page = await import('./+page.server');
const { parseNbt, writeNbt, child } = await import('#lib/server/nbt.js');
const { createInstance, systemdStopped } = await import('../../../../../tests/helpers/instances');
const { load, post } = await import('../../../../../tests/helpers/routes');

/**
 * From 1.21.9 PvP, monsters, the Nether and command blocks are game rules, not
 * server.properties keys: Settings' Rules section sets them in the active world.
 */

const byte = (value: number): Tag => ({ type: 'byte', value });
const rules = (values: Record<string, number>) =>
	writeNbt({ name: '', root: { type: 'compound', value: [['data', { type: 'compound', value: Object.entries(values).map(([k, v]) => [k, byte(v)]) }]] }, gzipped: true });
const WORLD_26 = {
	'world/level.dat': writeNbt({ name: '', root: { type: 'compound', value: [['Data', { type: 'compound', value: [] }]] }, gzipped: true }),
	'world/data/minecraft/game_rules.dat': rules({ 'minecraft:pvp': 1, 'minecraft:spawn_monsters': 1, 'minecraft:allow_entering_nether_using_portals': 1, 'minecraft:command_blocks_work': 1, 'minecraft:keep_inventory': 0 })
};

describe("Settings' four game rules from 1.21.9", () => {
	it('loads them from the active world and saves the ones posted', async () => {
		systemdStopped();
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '26.3' }, WORLD_26);
		const params = { id: instance.id };
		const { properties } = (await load(page, { params })) as { properties: { gameRuleValues: Record<string, boolean> } };
		expect(properties.gameRuleValues).toEqual({
			'minecraft:pvp': true,
			'minecraft:spawn_monsters': true,
			'minecraft:allow_entering_nether_using_portals': true,
			'minecraft:command_blocks_work': true
		});
		// PvP unticked (absent but present), monsters ticked; the others not on this post.
		const result = await post(page.actions.gameRules, { params, fields: { 'present:minecraft:pvp': '1', 'present:minecraft:spawn_monsters': '1', 'minecraft:spawn_monsters': 'on' } });
		expect(result).toMatchObject({ ok: true, message: expect.stringMatching(/^Enable pvp changed\./) });
		const saved = parseNbt(await fs.readFile(path.join(instance.path, 'world/data/minecraft/game_rules.dat'))).root;
		expect(child(child(saved, 'data'), 'minecraft:pvp')).toEqual(byte(0));
		expect(child(child(saved, 'data'), 'minecraft:spawn_monsters')).toEqual(byte(1));
	});

	it('are not offered before 1.21.9, where server.properties still has the keys', async () => {
		systemdStopped();
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.8' });
		const { properties } = (await load(page, { params: { id: instance.id } })) as { properties: { gameRules: unknown; gameRuleValues: unknown } };
		expect(properties).toMatchObject({ gameRules: null, gameRuleValues: null });
	});
});
