import { beforeEach, describe, expect, it, vi } from 'vitest';

// The server, over RCON: `list` answers who is online, anything else is recorded and answered.
const rcon = vi.hoisted(() => ({ commands: [] as string[], online: ['Steve', 'Alex'], fail: false, answer: '§eDone the thing', answers: {} as Record<string, string> }));
vi.mock('#lib/server/rcon.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/rcon.js')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		if (rcon.fail) throw new Error('connection refused');
		return commands.map((command) => {
			if (command === 'list') return `There are ${rcon.online.length} of a max of 20 players online: ${rcon.online.join(', ')}`;
			rcon.commands.push(command);
			return rcon.answers[command] ?? rcon.answer;
		});
	})
}));

const { gameModeCommand, gameModesFor, ownSpawnCommand, playerState, readPlayerState, runPlayerCommand, teleportCommand, teleportTargetFrom } = await import('#lib/server/playercommands.js');
const { encryptSecret } = await import('#lib/server/crypto.js');
const { createInstance } = await import('../helpers/instances');

/** Game mode and teleport for online players, as each Minecraft version takes the commands. */

describe('the commands per Minecraft version', () => {
	it('offers the game modes the version has', () => {
		expect(gameModesFor('1.2.5')).toEqual(['survival', 'creative']);
		expect(gameModesFor('1.7.10')).toEqual(['survival', 'creative', 'adventure']);
		expect(gameModesFor('1.12.2')).toEqual(['survival', 'creative', 'adventure', 'spectator']);
		expect(gameModesFor('26.3')).toEqual(['survival', 'creative', 'adventure', 'spectator']);
		expect(gameModeCommand('1.12.2', 'Steve', 'creative')).toBe('gamemode creative Steve');
		expect(() => gameModeCommand('1.7.10', 'Steve', 'spectator')).toThrow(/no spectator/);
	});

	it('teleports into another dimension from 1.13 on, and within one before', () => {
		const coords = (dimension: string | null) => ({ kind: 'coords' as const, x: 10, y: 64, z: -5, dimension });
		expect(teleportCommand('1.20.1', 'Steve', coords('minecraft:the_nether'), null)).toBe('execute in minecraft:the_nether run tp Steve 10 64 -5');
		expect(teleportCommand('1.12.2', 'Steve', coords(null), null)).toBe('tp Steve 10 64 -5');
		expect(() => teleportCommand('1.12.2', 'Steve', coords('minecraft:the_nether'), null)).toThrow(/another dimension/);
		expect(() => teleportCommand('1.20.1', 'Steve', coords('the nether; op Steve'), null)).toThrow(/dimension id/);
		expect(() => teleportCommand('1.20.1', 'Steve', { ...coords(null), x: NaN }, null)).toThrow(/numbers/);
		expect(teleportCommand('1.20.1', 'Steve', { kind: 'player', name: 'Alex' }, null)).toBe('tp Steve Alex');
	});

	it('puts a player on the surface at the spawn, in the overworld from 1.13 on', () => {
		const spawn = { x: 100, z: -20 };
		expect(teleportCommand('1.21.1', 'Steve', { kind: 'spawn' }, spawn)).toBe('execute in minecraft:overworld run spreadplayers 100 -20 0 1 false Steve');
		expect(teleportCommand('1.12.2', 'Steve', { kind: 'spawn' }, spawn)).toBe('spreadplayers 100 -20 0 1 false Steve');
		expect(() => teleportCommand('1.7.10', 'Steve', { kind: 'spawn' }, spawn)).toThrow(/surface/);
		expect(() => teleportCommand('1.21.1', 'Steve', { kind: 'spawn' }, null)).toThrow(/level.dat/);
	});
});

/** `data get entity` answers as vanilla gave them with a client joined (2026-11-08), per field asked. */
const NONE = (field: string) => `Found no elements matching ${field}`;
const has = (value: string) => `Steve has the following entity data: ${value}`;
const FIELDS = ['playerGameType', 'Dimension', 'Pos', 'respawn', 'SpawnX', 'SpawnY', 'SpawnZ', 'SpawnDimension', 'SpawnForced'];
const answering = (given: Record<string, string>) => FIELDS.map((f) => (f in given ? has(given[f]) : NONE(f)));

describe("an online player's state", () => {
	it('reads 1.21.5 on: the respawn compound', () => {
		const state = readPlayerState(
			answering({ playerGameType: '1', Dimension: '"minecraft:the_nether"', Pos: '[9.5d, -60.0d, -8.5d]', respawn: '{pos: [I; 10, 70, -20], forced: 1b, pitch: 0.0f, dimension: "minecraft:overworld", yaw: 0.0f}' })
		);
		expect(state).toEqual({ gameMode: 'creative', dimension: 'minecraft:the_nether', pos: { x: 9.5, y: -60, z: -8.5 }, spawn: { x: 10, y: 70, z: -20, dimension: 'minecraft:overworld', forced: true } });
	});

	it('reads SpawnX/Y/Z before it, and numbered dimensions before 1.16', () => {
		const old = readPlayerState(answering({ playerGameType: '0', Dimension: '"minecraft:overworld"', Pos: '[1.0d, 2.0d, 3.0d]', SpawnX: '10', SpawnY: '70', SpawnZ: '-20', SpawnDimension: '"minecraft:the_nether"', SpawnForced: '0b' }));
		expect(old.spawn).toEqual({ x: 10, y: 70, z: -20, dimension: 'minecraft:the_nether', forced: false });
		const older = readPlayerState(answering({ playerGameType: '3', Dimension: '-1', SpawnX: '5', SpawnY: '64', SpawnZ: '5' }));
		expect(older).toMatchObject({ gameMode: 'spectator', dimension: 'minecraft:the_nether', pos: null, spawn: { dimension: 'minecraft:overworld' } });
		// A mod's numbered dimension is not guessed; no spawn point set is none.
		expect(readPlayerState(answering({ Dimension: '7' }))).toEqual({ gameMode: null, dimension: null, pos: null, spawn: null });
		expect(readPlayerState(['No entity was found'])).toEqual({ gameMode: null, dimension: null, pos: null, spawn: null });
	});

	it('teleports onto a bed or anchor, and to a /spawnpoint spot itself', () => {
		expect(ownSpawnCommand('Steve', { x: 10, y: 70, z: -20, dimension: 'minecraft:overworld', forced: true })).toBe('execute in minecraft:overworld run tp Steve 10 70 -20');
		expect(ownSpawnCommand('Steve', { x: 10, y: 70, z: -20, dimension: 'minecraft:the_nether', forced: false })).toBe('execute in minecraft:the_nether run tp Steve 10 71 -20');
		expect(() => ownSpawnCommand('Steve', { x: 0, y: 0, z: 0, dimension: 'x; op Steve', forced: true })).toThrow(/cannot name/);
	});

	it('takes the target from the teleport form', () => {
		const form = (fields: Record<string, string>) => Object.entries(fields).reduce((f, [k, v]) => (f.append(k, v), f), new FormData());
		expect(teleportTargetFrom(form({ to: 'ownSpawn' }))).toEqual({ kind: 'ownSpawn' });
		expect(teleportTargetFrom(form({ to: 'coords', x: '1', y: '2', z: '3', dimension: '' }))).toEqual({ kind: 'coords', x: 1, y: 2, z: 3, dimension: null });
		expect(teleportTargetFrom(form({ to: 'elsewhere' }))).toBeNull();
	});
});

describe('running them on a server', () => {
	beforeEach(() => {
		rcon.commands = [];
		rcon.online = ['Steve', 'Alex'];
		rcon.fail = false;
		rcon.answer = '§eDone the thing';
		rcon.answers = {};
	});

	it("reads a player's state and sends them to their own spawn point, which they must have", async () => {
		const instance = await server();
		const ask = (given: Record<string, string>) =>
			(rcon.answers = Object.fromEntries(FIELDS.map((f, i) => [`data get entity Steve ${f}`, answering(given)[i]])));
		ask({ playerGameType: '2', Dimension: '"minecraft:overworld"', respawn: '{pos: [I; 4, 65, 4], forced: 0b, dimension: "minecraft:overworld"}' });
		expect(await playerState(instance, 'steve')).toMatchObject({ gameMode: 'adventure', spawn: { x: 4, y: 65, z: 4 } });
		rcon.commands = [];
		await runPlayerCommand(instance, 'Steve', { kind: 'teleport', target: { kind: 'ownSpawn' } });
		expect(rcon.commands.at(-1)).toBe('execute in minecraft:overworld run tp Steve 4 66 4');
		ask({ playerGameType: '0' });
		await expect(runPlayerCommand(instance, 'Steve', { kind: 'teleport', target: { kind: 'ownSpawn' } })).rejects.toThrow(/no spawn point of their own/);
		await expect(playerState(instance, 'Herobrine')).rejects.toThrow(/not online/);
		const old = await createInstance({ modloader: 'forge', minecraftVersion: '1.12.2', rconPort: 25597, rconPasswordEnc: encryptSecret('pw') });
		await expect(playerState(old, 'Steve')).rejects.toThrow(/1.12.2 has no command/);
		await expect(runPlayerCommand(old, 'Steve', { kind: 'teleport', target: { kind: 'ownSpawn' } })).rejects.toThrow(/spawn point/);
	});
	const server = () => createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', rconPort: 25598, rconPasswordEnc: encryptSecret('pw') });

	it('acts on online players only, by their own spelling, and answers with what the server said', async () => {
		const instance = await server();
		expect(await runPlayerCommand(instance, 'steve', { kind: 'gamemode', mode: 'creative' })).toBe('Done the thing');
		expect(await runPlayerCommand(instance, 'Steve', { kind: 'teleport', target: { kind: 'player', name: 'alex' } })).toBe('Done the thing');
		expect(rcon.commands).toEqual(['gamemode creative Steve', 'tp Steve Alex']);
		await expect(runPlayerCommand(instance, 'Herobrine', { kind: 'gamemode', mode: 'creative' })).rejects.toThrow(/Herobrine is not online/);
		await expect(runPlayerCommand(instance, 'Steve', { kind: 'teleport', target: { kind: 'player', name: 'Notch' } })).rejects.toThrow(/Notch is not online/);
		// A name the list holds but no player can have is not put into a command.
		rcon.online = ['Steve x'];
		await expect(runPlayerCommand(instance, 'Steve x', { kind: 'gamemode', mode: 'creative' })).rejects.toThrow(/not online/);
		expect(rcon.commands).toHaveLength(2);
	});

	it('fails with what the server said when it refuses, rather than answering as if it had worked', async () => {
		const instance = await server();
		const nowhere = { kind: 'coords' as const, x: 1, y: 80, z: 1, dimension: 'minecraft:nope' };
		rcon.answer = "§cUnknown dimension 'minecraft:nope'";
		await expect(runPlayerCommand(instance, 'Steve', { kind: 'teleport', target: nowhere })).rejects.toThrow("Unknown dimension 'minecraft:nope'");
		rcon.answer = 'Could not spread 1 entity around 0, 0 (too many entities for space - try using spread of at most 0.00)';
		await expect(runPlayerCommand(instance, 'Steve', { kind: 'teleport', target: { kind: 'player', name: 'Alex' } })).rejects.toThrow(/Could not spread/);
	});

	it('says so when RCON does not answer', async () => {
		const instance = await server();
		rcon.fail = true;
		await expect(runPlayerCommand(instance, 'Steve', { kind: 'gamemode', mode: 'survival' })).rejects.toThrow(/not reachable over RCON/);
	});
});
