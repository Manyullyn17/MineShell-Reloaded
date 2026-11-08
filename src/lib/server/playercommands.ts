import { compareVersions } from './java';
import { onlinePlayers, rconPassword, InstanceError } from './instances';
import { REFUSED } from './players';
import { rconExec } from './rcon';
import { child, num, str, type Tag } from './nbt';
import { parseSnbt } from './snbt';
import { savedBlocks, worldSpawn } from './world';
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
 * Blocks a player can stand in: air, and torches, which have nothing to bump into. Only names
 * every version from 1.13 on knows: an unknown one fails the whole command.
 */
const PASSABLE = ['air', 'cave_air', 'void_air', 'torch', 'wall_torch', 'redstone_torch', 'redstone_wall_torch'];
/** Nothing to stand on, besides those. */
const NO_FLOOR = ['water', 'lava', 'fire'];
/** Beside the block, the sides first. */
const AROUND = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];

/** Where a player's feet go: on the spot, or beside it on a floor. */
export type StandingSpot = { x: number; y: number; z: number; floor: boolean };

/**
 * Where to put a player at their spawn point, best first. A bed or anchor is the block saved, not
 * where they stand: on top of it (a bed is shorter: they drop onto it), else beside it, as the
 * game stands them up beside a bed whose top is under a ceiling. A /spawnpoint is the spot itself.
 */
export function standingSpots(spawn: PlayerSpawn): StandingSpot[] {
	const first = { x: spawn.x, y: spawn.forced ? spawn.y : spawn.y + 1, z: spawn.z, floor: false };
	return [first, ...AROUND.map(([dx, dz]) => ({ x: spawn.x + dx, y: spawn.y, z: spawn.z + dz, floor: true }))];
}

type Check = { at: [number, number, number]; floor: boolean };

/** What each spot needs: room for the player's feet and head, and under a spot beside, a floor. */
function spotChecks(spot: StandingSpot): Check[] {
	const { x, y, z } = spot;
	const checks: Check[] = [{ at: [x, y, z], floor: false }, { at: [x, y + 1, z], floor: false }];
	if (spot.floor) checks.push({ at: [x, y - 1, z], floor: true });
	return checks;
}

/** Passes ("Test passed") when the block is in the way, or, asked for a floor, is one. */
function checkCommand(dimension: string, { at, floor }: Check): string {
	const names = floor ? [...PASSABLE, ...NO_FLOOR] : PASSABLE;
	return `execute in ${dimension} ${names.map((n) => `unless block ${at.join(' ')} minecraft:${n}`).join(' ')}`;
}

/** The same as checkCommand from a block's name; read from the region file. */
const checkName = (name: string, floor: boolean) => {
	const bare = name.replace(/^minecraft:/, '');
	return !PASSABLE.includes(bare) && (!floor || !NO_FLOOR.includes(bare));
};

/**
 * The first spot at their spawn point with room for them, asked of the game; a chunk it does not
 * have loaded is read from the region file. A block neither can tell counts as in the way: never
 * teleport someone into a wall.
 */
async function standingSpot(instance: ServerInstance, password: string, spawn: PlayerSpawn): Promise<StandingSpot | null> {
	const spots = standingSpots(spawn);
	const checks = [...new Map(spots.flatMap(spotChecks).map((c) => [`${c.at.join(' ')} ${c.floor}`, c])).values()];
	let answers: (string | undefined)[];
	try {
		answers = await rconExec({ port: instance.rconPort, password }, checks.map((c) => checkCommand(spawn.dimension, c)));
	} catch {
		throw new InstanceError('The server is not reachable over RCON.');
	}
	const results = new Map<string, boolean | null>();
	checks.forEach((c, i) => {
		const said = plain(answers[i] ?? '');
		// A failed test answers "Test failed" (vanilla 1.21.1) or nothing (1.21.11); "not loaded" is neither.
		results.set(`${c.at.join(' ')} ${c.floor}`, /^Test passed/.test(said) ? true : said === '' || /^Test failed/.test(said) ? false : null);
	});
	const unknown = checks.filter((c) => results.get(`${c.at.join(' ')} ${c.floor}`) === null);
	if (unknown.length) {
		const saved = await savedBlocks(instance.path, spawn.dimension, unknown.map((c) => c.at));
		for (const c of unknown) {
			const name = saved.get(c.at.join(' '));
			if (name) results.set(`${c.at.join(' ')} ${c.floor}`, checkName(name, c.floor));
		}
	}
	const ok = (c: Check) => results.get(`${c.at.join(' ')} ${c.floor}`) === c.floor;
	return spots.find((spot) => spotChecks(spot).every(ok)) ?? null;
}

/** To a spot at their spawn point (standingSpots). tp centres whole x and z on the block. */
export function ownSpawnCommand(name: string, dimension: string, spot: StandingSpot): string {
	if (!DIMENSION.test(dimension)) throw new InstanceError('Their spawn point is in a dimension MineShell cannot name.');
	return `execute in ${dimension} run tp ${name} ${spot.x} ${spot.y} ${spot.z}`;
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
		if (!DIMENSION.test(spawn.dimension)) throw new InstanceError('Their spawn point is in a dimension MineShell cannot name.');
		const spot = await standingSpot(instance, password, spawn);
		if (!spot) throw new InstanceError(`There is no room for ${player} on or beside their spawn point at ${spawn.x}, ${spawn.y}, ${spawn.z}, so they were not teleported: it would put them in a wall.`);
		command = ownSpawnCommand(player, spawn.dimension, spot);
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
