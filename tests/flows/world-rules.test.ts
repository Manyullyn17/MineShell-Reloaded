import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tag } from '#lib/server/nbt.js';

const rcon = vi.hoisted(() => ({ commands: [] as string[], answer: '' }));
vi.mock('#lib/server/rcon.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/rcon.js')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		rcon.commands.push(...commands);
		return commands.map(() => rcon.answer);
	})
}));

const { readWorldRules, changeWorldRules } = await import('#lib/server/worldrules.js');
const { parseNbt, writeNbt, child } = await import('#lib/server/nbt.js');
const { encryptSecret } = await import('#lib/server/crypto.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { createInstance, systemdStopped } = await import('../helpers/instances');
const { readProperties } = await import('#lib/server/properties.js');
const { fakeProcesses } = await import('../helpers/process');

/**
 * A world's game rules, spawn and border in each format Minecraft has kept them in (checked on
 * vanilla 1.12.2, 1.21.10, 1.21.11 and 26.3 by booting the written files: worldrules.ts).
 */

const compound = (entries: [string, Tag][]): Tag => ({ type: 'compound', value: entries });
const nbt = (root: [string, Tag][]) => writeNbt({ name: '', root: { type: 'compound', value: root }, gzipped: true });
const str = (value: string): Tag => ({ type: 'string', value });
const int = (value: number): Tag => ({ type: 'int', value });
const byte = (value: number): Tag => ({ type: 'byte', value });
const dbl = (value: number): Tag => ({ type: 'double', value });

/** Up to 1.21.10: strings in level.dat, the border there too. */
const OLD = {
	'world/level.dat': nbt([
		[
			'Data',
			compound([
				['GameRules', compound([['keepInventory', str('false')], ['randomTickSpeed', str('3')], ['gameLoopFunction', str('-')], ['someModRule', str('true')]])],
				['SpawnX', int(100)],
				['SpawnY', int(64)],
				['SpawnZ', int(-50)],
				['BorderCenterX', dbl(0)],
				['BorderCenterZ', dbl(0)],
				['BorderSize', dbl(60_000_000)],
				['BorderSizeLerpTarget', dbl(60_000_000)]
			])
		]
	])
};
/** 1.21.11: typed rules in level.dat, spawn.pos, the border in data/world_border.dat. */
const MID = {
	'world/level.dat': nbt([
		['Data', compound([['game_rules', compound([['minecraft:keep_inventory', byte(0)], ['minecraft:random_tick_speed', int(3)]])], ['spawn', compound([['pos', { type: 'intArray', value: [1, 70, 2] }], ['dimension', str('minecraft:overworld')]])]])]
	]),
	'world/data/world_border.dat': nbt([['data', compound([['center_x', dbl(0)], ['center_z', dbl(0)], ['size', dbl(59_999_968)], ['lerp_target', dbl(59_999_968)]])]])
};
/** 26: the rules in data/minecraft/game_rules.dat, the border under dimensions/. */
const NEW = {
	'world/level.dat': nbt([['Data', compound([['spawn', compound([['pos', { type: 'intArray', value: [1, 70, 2] }]])]])]]),
	'world/data/minecraft/game_rules.dat': nbt([['data', compound([['minecraft:keep_inventory', byte(0)], ['minecraft:random_tick_speed', int(3)]])]]),
	'world/dimensions/minecraft/overworld/data/minecraft/world_border.dat': nbt([['data', compound([['center_x', dbl(0)], ['center_z', dbl(0)], ['size', dbl(59_999_968)], ['lerp_target', dbl(59_999_968)]])]])
};

const server = (files: Record<string, Buffer>, minecraftVersion = '1.21.1') =>
	createInstance({ modloader: 'vanilla', minecraftVersion, rconPort: 25599, rconPasswordEnc: encryptSecret('pw') }, files);
const readTag = async (file: string, ...names: string[]) => {
	let tag: Tag | undefined = parseNbt(await fs.readFile(file)).root;
	for (const n of names) tag = child(tag, n);
	return tag;
};

function running() {
	invalidateUnitState();
	fakeProcesses((_cmd, args) => (args.includes('show') ? { stdout: 'ActiveState=active\nSubState=running\n' } : {}));
}

describe("a world's game rules, spawn and border", () => {
	beforeEach(() => {
		systemdStopped();
		rcon.commands = [];
		rcon.answer = '';
	});

	it('reads each format, naming the rules and typing their values', async () => {
		const old = await readWorldRules(await server(OLD), 'world');
		expect(old).toMatchObject({ live: false, spawn: { x: 100, y: 64, z: -50 }, border: null });
		expect(old.rules.map((r) => [r.key, r.name, r.value, r.vanilla])).toEqual([
			['keepInventory', 'Keep inventory after death', false, true],
			['someModRule', 'Some mod rule', true, false],
			['gameLoopFunction', 'Game loop function', '-', false],
			['randomTickSpeed', 'Random tick speed rate', 3, true]
		]);
		const mid = await readWorldRules(await server(MID), 'world');
		expect(mid).toMatchObject({ spawn: { x: 1, y: 70, z: 2 }, border: null });
		expect(mid.rules.map((r) => [r.key, r.value])).toEqual([['minecraft:keep_inventory', false], ['minecraft:random_tick_speed', 3]]);
		const now = await readWorldRules(await server(NEW), 'world');
		expect(now.rules.map((r) => [r.name, r.value])).toEqual([['Keep inventory after death', false], ['Random tick speed rate', 3]]);
	});

	it('writes a stopped world in its own format, types kept', async () => {
		const changes = { spawn: { x: 11, y: 90, z: 22 }, border: { x: 5, z: 6, size: 3000 } };
		const old = await server(OLD);
		expect(await changeWorldRules(old, 'world', { ...changes, rules: { keepInventory: true, randomTickSpeed: 7 } })).toMatch(/^2 game rules changed, spawn set to 11, 90, 22, border 3,000 blocks across at 5, 6\./);
		const level = path.join(old.path, 'world/level.dat');
		expect(await readTag(level, 'Data', 'GameRules', 'keepInventory')).toEqual(str('true'));
		expect(await readTag(level, 'Data', 'GameRules', 'randomTickSpeed')).toEqual(str('7'));
		expect(await readTag(level, 'Data', 'SpawnY')).toEqual(int(90));
		expect(await readTag(level, 'Data', 'BorderSize')).toEqual(dbl(3000));

		const mid = await server(MID);
		await changeWorldRules(mid, 'world', { ...changes, rules: { 'minecraft:keep_inventory': true, 'minecraft:random_tick_speed': 7 } });
		expect(await readTag(path.join(mid.path, 'world/level.dat'), 'Data', 'game_rules', 'minecraft:keep_inventory')).toEqual(byte(1));
		expect(await readTag(path.join(mid.path, 'world/level.dat'), 'Data', 'spawn', 'pos')).toEqual({ type: 'intArray', value: [11, 90, 22] });
		expect(await readTag(path.join(mid.path, 'world/data/world_border.dat'), 'data', 'size')).toEqual(dbl(3000));

		const now = await server(NEW);
		await changeWorldRules(now, 'world', { ...changes, rules: { 'minecraft:random_tick_speed': 7 } });
		expect(await readTag(path.join(now.path, 'world/data/minecraft/game_rules.dat'), 'data', 'minecraft:random_tick_speed')).toEqual(int(7));
		expect((await readWorldRules(now, 'world')).border).toEqual({ x: 5, z: 6, size: 3000 });
		// Taken away again: back to the world's edge.
		await changeWorldRules(now, 'world', { border: null });
		expect((await readWorldRules(now, 'world')).border).toBeNull();
	});

	it('changes the running server over RCON, by the names its commands take, and only what differs', async () => {
		const instance = await server(MID, '1.21.11');
		running();
		expect((await readWorldRules(instance, 'world')).live).toBe(true);
		const before = await fs.readFile(path.join(instance.path, 'world/level.dat'));
		await changeWorldRules(instance, 'world', { rules: { 'minecraft:keep_inventory': true, 'minecraft:random_tick_speed': 3 }, spawn: { x: 1, y: 70, z: 2 }, border: { x: 5, z: 6, size: 3000 } });
		expect(rcon.commands).toEqual(['gamerule keep_inventory true', 'worldborder center 5 6', 'worldborder set 3000']);
		expect(await fs.readFile(path.join(instance.path, 'world/level.dat'))).toEqual(before);
		rcon.answer = 'Incorrect argument for command';
		await expect(changeWorldRules(instance, 'world', { rules: { 'minecraft:keep_inventory': true } })).rejects.toThrow(/refused "gamerule keep_inventory true"/);
	});

	it('refuses rules the world does not have, values of the wrong kind, and worlds not on the server', async () => {
		const instance = await server(OLD);
		await expect(changeWorldRules(instance, 'world', { rules: { noSuchRule: true } })).rejects.toThrow(/no game rule called noSuchRule/);
		await expect(changeWorldRules(instance, 'world', { rules: { keepInventory: 1 } })).rejects.toThrow(/on or off/);
		await expect(changeWorldRules(instance, 'world', { rules: { randomTickSpeed: 1.5 } })).rejects.toThrow(/whole number/);
		await expect(changeWorldRules(instance, 'world', { rules: { gameLoopFunction: 'a\nb' } })).rejects.toThrow(/one line/);
		await expect(changeWorldRules(instance, 'world', { border: { x: 0, z: 0, size: 0 } })).rejects.toThrow(/blocks across/);
		await expect(readWorldRules(instance, '../elsewhere')).rejects.toThrow(/not on this server/);
		expect(await changeWorldRules(instance, 'world', { rules: { keepInventory: false } })).toBe('Nothing changed.');
	});

	it("keeps the server's world size limit beside the border, in server.properties, for 1.8 and newer", async () => {
		const props = (dir: string) => readProperties(dir).then((p) => p.values);
		const instance = await server({ ...OLD, 'server.properties': Buffer.from('motd=Hi\n') });
		// Not in the file before the first start: Minecraft's own.
		expect((await readWorldRules(instance, 'world')).maxWorldSize).toBe(29_999_984);
		expect(await changeWorldRules(instance, 'world', { maxWorldSize: 5000 })).toMatch(/limit \(5,000 blocks from 0,0\) applies from the server's next start/);
		expect(await props(instance.path)).toEqual({ motd: 'Hi', 'max-world-size': '5000' });
		expect((await readWorldRules(instance, 'world')).maxWorldSize).toBe(5000);
		await expect(changeWorldRules(instance, 'world', { maxWorldSize: 30_000_000 })).rejects.toThrow(/1 to 29,999,984/);
		await expect(changeWorldRules(instance, 'world', { maxWorldSize: 0 })).rejects.toThrow(/1 to 29,999,984/);

		// Over RCON with the rest; a refusal there leaves the limit as it was too.
		const live = await server({ ...MID, 'server.properties': Buffer.from('max-world-size=1000\n') }, '1.21.11');
		running();
		rcon.answer = 'Incorrect argument for command';
		await expect(changeWorldRules(live, 'world', { rules: { 'minecraft:keep_inventory': true }, maxWorldSize: 2000 })).rejects.toThrow(/refused/);
		expect((await props(live.path))['max-world-size']).toBe('1000');
		rcon.answer = '';
		expect(await changeWorldRules(live, 'world', { rules: { 'minecraft:keep_inventory': true }, maxWorldSize: 2000 })).toMatch(/^Keep inventory after death changed\. The world size limit/);
		expect((await props(live.path))['max-world-size']).toBe('2000');

		systemdStopped();
		const ancient = await server(OLD, '1.7.10');
		expect((await readWorldRules(ancient, 'world')).maxWorldSize).toBeNull();
		await expect(changeWorldRules(ancient, 'world', { maxWorldSize: 100 })).rejects.toThrow(/before 1.8/);
	});
});
