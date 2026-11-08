import { compareVersions } from './java';
import { onlinePlayers, rconPassword, InstanceError } from './instances';
import { REFUSED } from './players';
import { rconExec } from './rcon';
import { child, num, str, type Tag } from './nbt';
import { parseSnbt } from './snbt';
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
	/** Their own spawn point (a bed, an anchor, /spawnpoint), read from the game (1.13+). */
	| { kind: 'ownSpawn' }
	| { kind: 'coords'; x: number; y: number; z: number; /** Minecraft's id (minecraft:the_nether); none: where the player is. */ dimension: string | null };

const atLeast = (minecraft: string, version: string) => compareVersions(minecraft, version) >= 0;

/** Spectator came with 1.8, adventure with 1.3. */
export function gameModesFor(minecraft: string): GameMode[] {
	return GAME_MODES.filter((m) => (m === 'spectator' ? atLeast(minecraft, '1.8') : m === 'adventure' ? atLeast(minecraft, '1.3') : true));
}

/** Teleporting into another dimension (`execute in`) came with 1.13; before it, vanilla only moves within one. */
export const crossesDimensions = (minecraft: string) => atLeast(minecraft, '1.13');

/** `data get entity` (1.13) reads a player's game mode, dimension, position and spawn point. */
export const readsPlayers = (minecraft: string) => atLeast(minecraft, '1.13');

/** `spreadplayers` (1.8) puts a player on the surface at a spot: the spawn's height is not stored. */
export const reachesSpawn = (minecraft: string) => atLeast(minecraft, '1.8');

const NAME = /^[A-Za-z0-9_]{1,16}$/;
const DIMENSION = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

export function gameModeCommand(minecraft: string, name: string, mode: GameMode): string {
	if (!gameModesFor(minecraft).includes(mode)) throw new InstanceError(`Minecraft ${minecraft} has no ${mode} mode.`);
	return `gamemode ${mode} ${name}`;
}

/** Every target but their own spawn point, which needs the game asked first (ownSpawnCommand). */
export function teleportCommand(minecraft: string, name: string, target: Exclude<TeleportTarget, { kind: 'ownSpawn' }>, spawn: { x: number; z: number } | null): string {
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

/** The teleport form's target (`to` and its fields), or null for none. */
export function teleportTargetFrom(form: FormData): TeleportTarget | null {
	const to = String(form.get('to') ?? '');
	const number = (key: string) => Number(String(form.get(key) ?? '').trim() || NaN);
	if (to === 'spawn') return { kind: 'spawn' };
	if (to === 'ownSpawn') return { kind: 'ownSpawn' };
	if (to === 'player') return { kind: 'player', name: String(form.get('player') ?? '').trim() };
	if (to === 'coords') return { kind: 'coords', x: number('x'), y: number('y'), z: number('z'), dimension: String(form.get('dimension') ?? '').trim() || null };
	return null;
}

/** RCON answers in the server's colours. */
const plain = (text: string) => text.replace(/§./g, '').trim();

export type PlayerSpawn = { x: number; y: number; z: number; dimension: string; /** Set by /spawnpoint: the exact spot, not a block to stand on. */ forced: boolean };
export type PlayerState = {
	gameMode: GameMode | null;
	/** Minecraft's id (minecraft:the_nether, a mod's); null when not known. */
	dimension: string | null;
	pos: { x: number; y: number; z: number } | null;
	/** Their own spawn point; null when they have none (they respawn at the world's). */
	spawn: PlayerSpawn | null;
};

/** The fields read, each with its own command: a whole player's data can pass RCON's 4096 bytes. */
const STATE_FIELDS = ['playerGameType', 'Dimension', 'Pos', 'respawn', 'SpawnX', 'SpawnY', 'SpawnZ', 'SpawnDimension', 'SpawnForced'] as const;
/** Before 1.16 a dimension is a number. */
const DIMENSION_NUMBERS: Record<number, string> = { 0: 'minecraft:overworld', [-1]: 'minecraft:the_nether', 1: 'minecraft:the_end' };

/** The value in `data get entity`'s answer ("Steve has the following entity data: 1b"), or null ("Found no elements matching ..."). */
function entityData(answer: string | undefined): Tag | null {
	const found = /has the following entity data: ([\s\S]*)$/.exec(plain(answer ?? ''));
	if (!found) return null;
	try {
		return parseSnbt(found[1]);
	} catch {
		return null;
	}
}

const dimensionOf = (tag: Tag | null | undefined): string | null => str(tag ?? undefined) ?? DIMENSION_NUMBERS[num(tag ?? undefined) ?? NaN] ?? null;

/**
 * A player's state from the answers to STATE_FIELDS' commands, in that order (read from vanilla
 * 1.21.1 and 1.21.11 with a client joined, 2026-11-08: `respawn` from 1.21.5, SpawnX/Y/Z,
 * SpawnDimension and SpawnForced before; neither until a spawn point is set).
 */
export function readPlayerState(answers: (string | undefined)[]): PlayerState {
	const [mode, dimension, pos, respawn, x, y, z, spawnDimension, forced] = answers.map(entityData);
	const coords = pos?.type === 'list' ? pos.value.map((t) => num(t)) : [];
	let spawn: PlayerSpawn | null = null;
	if (respawn?.type === 'compound') {
		const at = child(respawn, 'pos');
		if (at?.type === 'intArray' && at.value.length === 3) {
			spawn = { x: at.value[0], y: at.value[1], z: at.value[2], dimension: dimensionOf(child(respawn, 'dimension')) ?? 'minecraft:overworld', forced: num(child(respawn, 'forced')) === 1 };
		}
	} else if (x && y && z && num(x) !== null && num(y) !== null && num(z) !== null) {
		// Before 1.16 a spawn point could only be in the overworld (a bed elsewhere explodes).
		spawn = { x: num(x)!, y: num(y)!, z: num(z)!, dimension: dimensionOf(spawnDimension) ?? 'minecraft:overworld', forced: num(forced ?? undefined) === 1 };
	}
	const modeNumber = num(mode ?? undefined);
	return {
		gameMode: modeNumber !== null && modeNumber >= 0 && modeNumber < GAME_MODES.length ? GAME_MODES[modeNumber] : null,
		dimension: dimensionOf(dimension),
		pos: coords.length === 3 && coords.every((c) => c !== null) ? { x: coords[0]!, y: coords[1]!, z: coords[2]! } : null,
		spawn
	};
}

/**
 * To their spawn point. tp centres whole x and z on the block; a bed or anchor is the block
 * they stand on (a bed is shorter: they drop onto it), a /spawnpoint the spot itself.
 */
export function ownSpawnCommand(name: string, spawn: PlayerSpawn): string {
	if (!DIMENSION.test(spawn.dimension)) throw new InstanceError('Their spawn point is in a dimension MineShell cannot name.');
	return `execute in ${spawn.dimension} run tp ${name} ${spawn.x} ${spawn.forced ? spawn.y : spawn.y + 1} ${spawn.z}`;
}

/** The online player's name as the server spells it, or an error. */
async function onlineName(instance: ServerInstance, name: string): Promise<{ player: string; password: string; online: (who: string) => string | undefined }> {
	const password = rconPassword(instance);
	const players = await onlinePlayers(instance);
	if (!password || !players) throw new InstanceError('The server is not reachable over RCON.');
	const online = (who: string) => players.names.find((n) => n.toLowerCase() === who.toLowerCase());
	const player = online(name);
	if (!player || !NAME.test(player)) throw new InstanceError(`${name} is not online.`);
	return { player, password, online };
}

async function askState(instance: ServerInstance, password: string, player: string): Promise<PlayerState> {
	try {
		return readPlayerState(await rconExec({ port: instance.rconPort, password }, STATE_FIELDS.map((field) => `data get entity ${player} ${field}`)));
	} catch {
		throw new InstanceError('The server is not reachable over RCON.');
	}
}

/** What an online player is doing: game mode, dimension, position and spawn point (1.13+). */
export async function playerState(instance: ServerInstance, name: string): Promise<PlayerState> {
	if (!readsPlayers(instance.minecraftVersion)) throw new InstanceError(`Minecraft ${instance.minecraftVersion} has no command that reads a player's state.`);
	const { player, password } = await onlineName(instance, name);
	return askState(instance, password, player);
}

/**
 * Runs one of the commands above for a player who is online (and, to teleport to, a target
 * who is too), answering with what the server said.
 */
export async function runPlayerCommand(
	instance: ServerInstance,
	name: string,
	action: { kind: 'gamemode'; mode: GameMode } | { kind: 'teleport'; target: TeleportTarget }
): Promise<string> {
	const { player, password, online } = await onlineName(instance, name);
	let command: string;
	if (action.kind === 'gamemode') {
		command = gameModeCommand(instance.minecraftVersion, player, action.mode);
	} else if (action.target.kind === 'ownSpawn') {
		if (!readsPlayers(instance.minecraftVersion)) throw new InstanceError(`Minecraft ${instance.minecraftVersion} has no command that reads a player's spawn point.`);
		const { spawn } = await askState(instance, password, player);
		if (!spawn) throw new InstanceError(`${player} has no spawn point of their own: they would respawn at the world spawn.`);
		command = ownSpawnCommand(player, spawn);
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
