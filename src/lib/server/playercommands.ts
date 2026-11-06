import { compareVersions } from './java';
import { onlinePlayers, rconPassword, InstanceError } from './instances';
import { REFUSED } from './players';
import { rconExec } from './rcon';
import { worldSpawn } from './world';
import type { ServerInstance } from './db/schema';

/**
 * Game mode and teleport for online players, over RCON: the commands as each
 * Minecraft version takes them. Both are console-strength (creative mode, going
 * anywhere), so they sit under console.command, as making someone an operator does.
 */

export const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator'] as const;
export type GameMode = (typeof GAME_MODES)[number];

export type TeleportTarget =
	| { kind: 'player'; name: string }
	/** The world spawn, on the surface there. */
	| { kind: 'spawn' }
	| { kind: 'coords'; x: number; y: number; z: number; /** Minecraft's id (minecraft:the_nether); none: where the player is. */ dimension: string | null };

const atLeast = (minecraft: string, version: string) => compareVersions(minecraft, version) >= 0;

/** Spectator came with 1.8, adventure with 1.3. */
export function gameModesFor(minecraft: string): GameMode[] {
	return GAME_MODES.filter((m) => (m === 'spectator' ? atLeast(minecraft, '1.8') : m === 'adventure' ? atLeast(minecraft, '1.3') : true));
}

/** Teleporting into another dimension (`execute in`) came with 1.13; before it, vanilla only moves within one. */
export const crossesDimensions = (minecraft: string) => atLeast(minecraft, '1.13');

/** `spreadplayers` (1.8) puts a player on the surface at a spot: the spawn's height is not stored. */
export const reachesSpawn = (minecraft: string) => atLeast(minecraft, '1.8');

const NAME = /^[A-Za-z0-9_]{1,16}$/;
const DIMENSION = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

export function gameModeCommand(minecraft: string, name: string, mode: GameMode): string {
	if (!gameModesFor(minecraft).includes(mode)) throw new InstanceError(`Minecraft ${minecraft} has no ${mode} mode.`);
	return `gamemode ${mode} ${name}`;
}

export function teleportCommand(minecraft: string, name: string, target: TeleportTarget, spawn: { x: number; z: number } | null): string {
	if (target.kind === 'player') {
		if (!NAME.test(target.name)) throw new InstanceError('That is not a player name.');
		return `tp ${name} ${target.name}`;
	}
	if (target.kind === 'spawn') {
		if (!reachesSpawn(minecraft)) throw new InstanceError(`Minecraft ${minecraft} has no command that finds the surface at the spawn.`);
		if (!spawn) throw new InstanceError("The world's spawn could not be read from level.dat.");
		const spread = `spreadplayers ${spawn.x} ${spawn.z} 0 1 false ${name}`;
		return crossesDimensions(minecraft) ? `execute in minecraft:overworld run ${spread}` : spread;
	}
	const { x, y, z, dimension } = target;
	if (![x, y, z].every(Number.isFinite) || [x, y, z].some((n) => Math.abs(n) > 30_000_000)) throw new InstanceError('Give x, y and z as numbers.');
	const tp = `tp ${name} ${x} ${y} ${z}`;
	if (!dimension) return tp;
	if (!crossesDimensions(minecraft)) throw new InstanceError(`Minecraft ${minecraft} cannot teleport into another dimension.`);
	if (!DIMENSION.test(dimension)) throw new InstanceError('That is not a dimension id.');
	return `execute in ${dimension} run ${tp}`;
}

/** RCON answers in the server's colours. */
const plain = (text: string) => text.replace(/§./g, '').trim();

/**
 * Runs one of the commands above for a player who is online (and, to teleport to, a target
 * who is too), answering with what the server said.
 */
export async function runPlayerCommand(
	instance: ServerInstance,
	name: string,
	action: { kind: 'gamemode'; mode: GameMode } | { kind: 'teleport'; target: TeleportTarget }
): Promise<string> {
	const password = rconPassword(instance);
	const players = await onlinePlayers(instance);
	if (!password || !players) throw new InstanceError('The server is not reachable over RCON.');
	const online = (who: string) => players.names.find((n) => n.toLowerCase() === who.toLowerCase());
	const player = online(name);
	if (!player || !NAME.test(player)) throw new InstanceError(`${name} is not online.`);
	let command: string;
	if (action.kind === 'gamemode') {
		command = gameModeCommand(instance.minecraftVersion, player, action.mode);
	} else {
		let target = action.target;
		if (target.kind === 'player') {
			const other = online(target.name);
			if (!other) throw new InstanceError(`${target.name} is not online.`);
			target = { kind: 'player', name: other };
		}
		const spawn = target.kind === 'spawn' ? await worldSpawn(instance.path) : null;
		command = teleportCommand(instance.minecraftVersion, player, target, spawn);
	}
	let response: string | undefined;
	try {
		[response] = await rconExec({ port: instance.rconPort, password }, [command]);
	} catch {
		throw new InstanceError('The server is not reachable over RCON.');
	}
	const said = plain(response ?? '');
	if (REFUSED.test(said)) throw new InstanceError(said);
	return said || 'Done.';
}
