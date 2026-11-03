import { beforeEach, describe, expect, it, vi } from 'vitest';

// The server, over RCON: `list` answers who is online, anything else is recorded and answered.
const rcon = vi.hoisted(() => ({ commands: [] as string[], online: ['Steve', 'Alex'], fail: false }));
vi.mock('#lib/server/rcon.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/rcon.js')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		if (rcon.fail) throw new Error('connection refused');
		return commands.map((command) => {
			if (command === 'list') return `There are ${rcon.online.length} of a max of 20 players online: ${rcon.online.join(', ')}`;
			rcon.commands.push(command);
			return '§eDone the thing';
		});
	})
}));

const { gameModeCommand, gameModesFor, runPlayerCommand, teleportCommand } = await import('#lib/server/playercommands.js');
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

describe('running them on a server', () => {
	beforeEach(() => {
		rcon.commands = [];
		rcon.online = ['Steve', 'Alex'];
		rcon.fail = false;
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

	it('says so when RCON does not answer', async () => {
		const instance = await server();
		rcon.fail = true;
		await expect(runPlayerCommand(instance, 'Steve', { kind: 'gamemode', mode: 'survival' })).rejects.toThrow(/not reachable over RCON/);
	});
});
