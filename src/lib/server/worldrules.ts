import fs from 'node:fs/promises';
import path from 'node:path';
import { child, parseNbt, setChild, writeNbt, type Compound, type NbtFile, type Tag } from './nbt';
import { InstanceError, rconPassword } from './instances';
import { rconExec } from './rcon';
import { unitState } from './systemd';
import { serverWorldName } from './packworld';
import { worldFolderNames } from './worlds';
import { compareVersions } from './java';
import { isVanillaRule, ruleDescription, ruleLabel } from '#lib/shared/gamerules.js';
import type { ServerInstance } from './db/schema';

/**
 * A world's game rules, spawn and border (World > Game rules). Where a world keeps them
 * depends on the version that last saved it (checked on vanilla 1.12.2, 1.21.10, 1.21.11 and
 * 26.3 with tests/tools/mc-probe.mjs, 2026-11-03; docs/notes/worlds.md):
 *
 * - rules: level.dat's Data.GameRules, every rule (mods' too) a string, camelCase, up to
 *   1.21.10; Data.game_rules from 1.21.11, typed (a byte for true/false, an int), names
 *   `minecraft:snake_case`; 26's data/minecraft/game_rules.dat, the same under `data`.
 * - spawn: SpawnX/Y/Z, later `spawn.pos` (an int array, with its dimension).
 * - border: level.dat's Border* up to 1.21.10; then world_border.dat, in data/ (1.21.11) or
 *   dimensions/minecraft/overworld/data/minecraft/ (26).
 *
 * Changed over RCON for the active world of a running server (a file written under it would
 * be saved over), else in the files: an inactive world, or any world while stopped.
 */

export type RuleValue = boolean | number | string;
export type WorldRule = { key: string; name: string; description: string | null; value: RuleValue; vanilla: boolean };
export type WorldRules = {
	world: string;
	/** Changes go over RCON (the running server's active world). */
	live: boolean;
	rules: WorldRule[];
	spawn: { x: number; y: number; z: number } | null;
	/** Null when none is set (the default, the edge of the world). */
	border: { x: number; z: number; size: number } | null;
};
export type WorldRuleChanges = {
	rules?: Record<string, RuleValue>;
	spawn?: { x: number; y: number; z: number };
	/** Null takes the border away. */
	border?: { x: number; z: number; size: number } | null;
};

/** Minecraft's default border, the edge of the world: none set. 1.12 keeps 60,000,000. */
const NO_BORDER = 59_999_968;
const INT_MAX = 2_147_483_647;

type Rules = { store: 'strings' | 'typed'; file: string; nbt: NbtFile; compound: Compound };
type Border = { file: string; nbt: NbtFile; compound: Compound; keys: { x: string; z: string; size: string; target: string } };

async function readNbt(file: string): Promise<NbtFile | null> {
	const raw = await fs.readFile(file).catch(() => null);
	return raw ? parseNbt(raw) : null;
}

/** The rules' compound, from whichever file the world keeps it in. */
async function locateRules(dir: string, level: NbtFile): Promise<Rules | null> {
	const data = child(level.root, 'Data');
	const strings = child(data, 'GameRules');
	if (strings?.type === 'compound') return { store: 'strings', file: path.join(dir, 'level.dat'), nbt: level, compound: strings };
	const typed = child(data, 'game_rules');
	if (typed?.type === 'compound') return { store: 'typed', file: path.join(dir, 'level.dat'), nbt: level, compound: typed };
	const file = path.join(dir, 'data/minecraft/game_rules.dat');
	const own = await readNbt(file);
	const inner = child(own?.root, 'data');
	return own && inner?.type === 'compound' ? { store: 'typed', file, nbt: own, compound: inner } : null;
}

async function locateBorder(dir: string, level: NbtFile): Promise<Border | null> {
	for (const rel of ['dimensions/minecraft/overworld/data/minecraft/world_border.dat', 'data/minecraft/world_border.dat', 'data/world_border.dat']) {
		const file = path.join(dir, rel);
		const nbt = await readNbt(file);
		const inner = child(nbt?.root, 'data');
		if (nbt && inner?.type === 'compound') return { file, nbt, compound: inner, keys: { x: 'center_x', z: 'center_z', size: 'size', target: 'lerp_target' } };
	}
	const data = child(level.root, 'Data');
	if (data?.type !== 'compound' || !child(data, 'BorderSize')) return null;
	return { file: path.join(dir, 'level.dat'), nbt: level, compound: data, keys: { x: 'BorderCenterX', z: 'BorderCenterZ', size: 'BorderSize', target: 'BorderSizeLerpTarget' } };
}

function valueOf(tag: Tag, store: Rules['store']): RuleValue {
	if (tag.type === 'string') {
		if (store === 'strings' && (tag.value === 'true' || tag.value === 'false')) return tag.value === 'true';
		return store === 'strings' && /^-?\d+$/.test(tag.value) ? Number(tag.value) : tag.value;
	}
	if (tag.type === 'byte') return tag.value !== 0;
	if (tag.type === 'long') return Number(tag.value);
	return typeof tag.value === 'number' ? tag.value : String(tag.value);
}

const numberOf = (tag: Tag | undefined) => (tag && typeof tag.value === 'number' ? tag.value : tag?.type === 'long' ? Number(tag.value) : null);

/** The world folder asked for, which must be one of the server's. */
async function worldDir(instance: ServerInstance, world: string): Promise<string> {
	if (!(await worldFolderNames(instance.path)).includes(world)) throw new InstanceError('That world is not on this server.');
	return path.join(instance.path, world);
}

async function isLive(instance: ServerInstance, world: string): Promise<boolean> {
	return world === (await serverWorldName(instance.path)) && (await unitState(instance.id)).active === 'active';
}

export async function readWorldRules(instance: ServerInstance, world: string): Promise<WorldRules> {
	const dir = await worldDir(instance, world);
	const level = await readNbt(path.join(dir, 'level.dat'));
	if (!level) throw new InstanceError('This world has no level.dat yet: start the server once to create it.');
	const located = await locateRules(dir, level);
	const rules: WorldRule[] = (located?.compound.value ?? []).map(([key, tag]) => ({
		key,
		name: ruleLabel(key),
		description: ruleDescription(key),
		value: valueOf(tag, located!.store),
		vanilla: isVanillaRule(key)
	}));
	rules.sort((a, b) => Number(typeof a.value !== 'boolean') - Number(typeof b.value !== 'boolean') || a.name.localeCompare(b.name));

	const data = child(level.root, 'Data');
	const pos = child(child(data, 'spawn'), 'pos');
	const spawn =
		pos?.type === 'intArray' && pos.value.length === 3
			? { x: pos.value[0], y: pos.value[1], z: pos.value[2] }
			: numberOf(child(data, 'SpawnX')) !== null
				? { x: numberOf(child(data, 'SpawnX'))!, y: numberOf(child(data, 'SpawnY')) ?? 64, z: numberOf(child(data, 'SpawnZ'))! }
				: null;
	const located2 = await locateBorder(dir, level);
	const size = numberOf(child(located2?.compound, located2?.keys.size ?? ''));
	const border =
		located2 && size !== null && size > 0 && size < NO_BORDER
			? { x: numberOf(child(located2.compound, located2.keys.x)) ?? 0, z: numberOf(child(located2.compound, located2.keys.z)) ?? 0, size }
			: null;
	return { world, live: await isLive(instance, world), rules, spawn, border };
}

/** What a posted value is for a rule of this kind, or why it cannot be. */
function checkedValue(rule: WorldRule, value: RuleValue): RuleValue {
	if (typeof rule.value === 'boolean') {
		if (typeof value !== 'boolean') throw new InstanceError(`${rule.name} is on or off.`);
		return value;
	}
	if (typeof rule.value === 'number') {
		if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > INT_MAX) throw new InstanceError(`${rule.name} takes a whole number.`);
		return value;
	}
	const text = String(value);
	if (/[\r\n]/.test(text) || text.length > 256) throw new InstanceError(`${rule.name}: one line of text.`);
	return text;
}

const coordinate = (n: number, what: string) => {
	if (!Number.isFinite(n) || Math.abs(n) > 30_000_000) throw new InstanceError(`${what} is out of the world.`);
	return Math.round(n);
};

/**
 * Applies what changed and answers with what it did. Over RCON for the running server's
 * active world (Minecraft's own answer to each command is checked for a refusal), else into
 * the world's files, each written to a temporary file and renamed over the old one.
 */
export async function changeWorldRules(instance: ServerInstance, world: string, changes: WorldRuleChanges): Promise<string> {
	const current = await readWorldRules(instance, world);
	const byKey = new Map(current.rules.map((r) => [r.key, r]));
	const rules: [WorldRule, RuleValue][] = [];
	for (const [key, raw] of Object.entries(changes.rules ?? {})) {
		const rule = byKey.get(key);
		if (!rule) throw new InstanceError(`This world has no game rule called ${key}.`);
		const value = checkedValue(rule, raw);
		if (value !== rule.value) rules.push([rule, value]);
	}
	const spawn = changes.spawn && { x: coordinate(changes.spawn.x, 'The spawn'), y: coordinate(changes.spawn.y, 'The spawn'), z: coordinate(changes.spawn.z, 'The spawn') };
	const spawnChanged = !!spawn && JSON.stringify(spawn) !== JSON.stringify(current.spawn);
	let border = changes.border;
	if (border) {
		border = { x: coordinate(border.x, 'The border centre'), z: coordinate(border.z, 'The border centre'), size: Math.round(border.size) };
		if (!(border.size >= 1 && border.size < NO_BORDER)) throw new InstanceError(`The border is 1 to ${(NO_BORDER - 1).toLocaleString('en')} blocks across.`);
	}
	const borderChanged = border !== undefined && JSON.stringify(border) !== JSON.stringify(current.border);
	if (!rules.length && !spawnChanged && !borderChanged) return 'Nothing changed.';

	const said: string[] = [];
	if (rules.length) said.push(`${rules.length === 1 ? rules[0][0].name : `${rules.length} game rules`} changed`);
	if (spawnChanged) said.push(`spawn set to ${spawn!.x}, ${spawn!.y}, ${spawn!.z}`);
	if (borderChanged) said.push(border ? `border ${border.size.toLocaleString('en')} blocks across at ${border.x}, ${border.z}` : 'border taken away');

	if (current.live) {
		const commands = rules.map(([rule, value]) => `gamerule ${rule.key.replace(/^minecraft:/, '')} ${value}`);
		// From the console, setworldspawn sets the overworld's.
		if (spawnChanged) commands.push(`setworldspawn ${spawn!.x} ${spawn!.y} ${spawn!.z}`);
		if (borderChanged) commands.push(...(border ? [`worldborder center ${border.x} ${border.z}`, `worldborder set ${border.size}`] : [`worldborder set ${NO_BORDER}`]));
		await viaRcon(instance, commands);
		return `${capitalise(said.join(', '))}.`;
	}

	const dir = await worldDir(instance, world);
	const level = (await readNbt(path.join(dir, 'level.dat')))!;
	const writes = new Map<string, NbtFile>();
	if (rules.length) {
		const located = (await locateRules(dir, level))!;
		for (const [rule, value] of rules) {
			const old = child(located.compound, rule.key)!;
			setChild(located.compound, rule.key, located.store === 'strings' ? { type: 'string', value: String(value) } : typedTag(old, value));
		}
		writes.set(located.file, located.nbt);
	}
	if (spawnChanged) {
		const data = child(level.root, 'Data') as Compound;
		const pos = child(child(data, 'spawn'), 'pos');
		if (pos?.type === 'intArray') pos.value = [spawn!.x, spawn!.y, spawn!.z];
		else for (const [k, v] of [['SpawnX', spawn!.x], ['SpawnY', spawn!.y], ['SpawnZ', spawn!.z]] as const) setChild(data, k, { type: 'int', value: v });
		writes.set(path.join(dir, 'level.dat'), level);
	}
	if (borderChanged) {
		const located = await locateBorder(dir, level);
		if (!located) throw new InstanceError('This world keeps no border to change yet: start the server once.');
		const size = border?.size ?? NO_BORDER;
		const set = (key: string, value: number) => setChild(located.compound, key, { type: 'double', value });
		if (border) {
			set(located.keys.x, border.x);
			set(located.keys.z, border.z);
		}
		set(located.keys.size, size);
		set(located.keys.target, size);
		writes.set(located.file, located.nbt);
	}
	for (const [file, nbt] of writes) {
		const tmp = `${file}.mineshell-tmp`;
		await fs.writeFile(tmp, writeNbt(nbt));
		await fs.rename(tmp, file);
	}
	return `${capitalise(said.join(', '))}. ${world === (await serverWorldName(instance.path)) ? 'The server reads it at its next start.' : 'The world has it when it is next played.'}`;
}

/** A typed rule keeps its own tag type: a byte for on or off, the number's own width. */
function typedTag(old: Tag, value: RuleValue): Tag {
	if (typeof value === 'boolean') return { type: 'byte', value: value ? 1 : 0 };
	if (typeof value === 'number') return old.type === 'long' ? { type: 'long', value: BigInt(value) } : { type: old.type === 'short' || old.type === 'byte' ? old.type : 'int', value };
	return { type: 'string', value };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Each command over RCON; Minecraft's refusals ("Incorrect argument", "Unknown") stop it with what it said. */
async function viaRcon(instance: ServerInstance, commands: string[]): Promise<void> {
	const password = rconPassword(instance);
	if (!password) throw new InstanceError('The server is not reachable over RCON.');
	let answers: string[];
	try {
		answers = await rconExec({ port: instance.rconPort, password }, commands);
	} catch {
		throw new InstanceError('The server is not reachable over RCON.');
	}
	const refused = answers.findIndex((a) => /incorrect argument|unknown or incomplete|unknown command|no game rule|invalid|expected/i.test(a ?? ''));
	if (refused >= 0) throw new InstanceError(`The server refused "${commands[refused]}": ${(answers[refused] ?? '').replace(/§./g, '').trim()}`);
}

/**
 * The active world's values of these rules (names as movedGameRules gives them, with or
 * without `minecraft:`), by the key the world stores; null when the world cannot be read
 * yet (no level.dat before the first start).
 */
export async function activeWorldRuleValues(instance: ServerInstance, names: string[]): Promise<Record<string, boolean> | null> {
	try {
		const { rules } = await readWorldRules(instance, await serverWorldName(instance.path));
		const found = names.map((name) => rules.find((r) => r.key.replace(/^minecraft:/, '') === name && typeof r.value === 'boolean'));
		return Object.fromEntries(found.filter((r) => !!r).map((r) => [r!.key, r!.value as boolean]));
	} catch {
		return null;
	}
}

/** Whether this Minecraft version keeps a border (1.8 brought it). */
export const hasBorder = (minecraft: string) => compareVersions(minecraft, '1.8') >= 0;
