import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { playerFields as playerFieldsTable } from './db/schema';
import { child, num, setChild, shortestFloat, type Compound, type Tag } from './nbt';
import { PlayerDataError } from './playeritems';
import type { Path, TagType } from '$lib/shared/nbt';

/**
 * The player's values as form fields: built-in ones (stats up front, the
 * rarer ones under Advanced), effects, and fields someone mapped onto a
 * path in the raw tree. A field only shows when the file has its value;
 * where a value moved between versions, each place is tried in turn.
 */

export type FieldKind = 'number' | 'checkbox' | 'select' | 'text';

export type FieldView = {
	key: string;
	label: string;
	group: 'basic' | 'advanced' | 'attributes';
	kind: FieldKind;
	path: Path;
	type: TagType;
	/** As the input shows it: numbers and text as text, checkboxes as true/false. */
	value: string | boolean;
	options?: { value: string; label: string }[];
	hint?: string;
};

type FieldDef = {
	key: string;
	label: string;
	group: 'basic' | 'advanced';
	/** Places the value has lived, newest first. */
	paths: Path[];
	kind?: FieldKind;
	options?: { value: string; label: string }[];
	hint?: string;
};

const GAME_MODES = ['Survival', 'Creative', 'Adventure', 'Spectator'].map((label, i) => ({ value: String(i), label }));
const OLD_DIMENSIONS = [
	{ value: '0', label: 'Overworld' },
	{ value: '-1', label: 'Nether' },
	{ value: '1', label: 'End' }
];

const FIELDS: FieldDef[] = [
	{ key: 'health', label: 'Health', group: 'basic', paths: [['Health']], hint: '20 is ten hearts.' },
	{ key: 'food', label: 'Food', group: 'basic', paths: [['foodLevel']], hint: '0 to 20.' },
	{ key: 'saturation', label: 'Saturation', group: 'basic', paths: [['foodSaturationLevel']] },
	{ key: 'xpLevel', label: 'XP level', group: 'basic', paths: [['XpLevel']] },
	{ key: 'gameMode', label: 'Game mode', group: 'basic', paths: [['playerGameType']], kind: 'select', options: GAME_MODES },
	{ key: 'x', label: 'X', group: 'basic', paths: [['Pos', 0]] },
	{ key: 'y', label: 'Y', group: 'basic', paths: [['Pos', 1]] },
	{ key: 'z', label: 'Z', group: 'basic', paths: [['Pos', 2]] },
	{ key: 'dimension', label: 'Dimension', group: 'basic', paths: [['Dimension']], hint: 'minecraft:overworld, minecraft:the_nether, minecraft:the_end or a mod’s.' },

	{ key: 'mayfly', label: 'Can fly', group: 'advanced', paths: [['abilities', 'mayfly']], kind: 'checkbox' },
	{ key: 'flying', label: 'Flying now', group: 'advanced', paths: [['abilities', 'flying']], kind: 'checkbox' },
	{ key: 'invulnerable', label: 'Invulnerable', group: 'advanced', paths: [['abilities', 'invulnerable']], kind: 'checkbox' },
	{ key: 'instabuild', label: 'Instant build', group: 'advanced', paths: [['abilities', 'instabuild']], kind: 'checkbox' },
	{ key: 'mayBuild', label: 'Can build', group: 'advanced', paths: [['abilities', 'mayBuild']], kind: 'checkbox' },
	{ key: 'walkSpeed', label: 'Walk speed', group: 'advanced', paths: [['abilities', 'walkSpeed']], hint: 'Default 0.1.' },
	{ key: 'flySpeed', label: 'Fly speed', group: 'advanced', paths: [['abilities', 'flySpeed']], hint: 'Default 0.05.' },
	{ key: 'xpProgress', label: 'XP to next level', group: 'advanced', paths: [['XpP']], hint: '0 to 1.' },
	{ key: 'xpTotal', label: 'XP total', group: 'advanced', paths: [['XpTotal']] },
	{ key: 'score', label: 'Score', group: 'advanced', paths: [['Score']], hint: 'Shown on the death screen.' },
	{ key: 'exhaustion', label: 'Exhaustion', group: 'advanced', paths: [['foodExhaustionLevel']] },
	{ key: 'absorption', label: 'Absorption', group: 'advanced', paths: [['AbsorptionAmount']] },
	{ key: 'air', label: 'Air', group: 'advanced', paths: [['Air']], hint: '300 is full.' },
	{ key: 'fire', label: 'Fire ticks', group: 'advanced', paths: [['Fire']], hint: '-20 is not burning.' },
	{ key: 'fall', label: 'Fall distance', group: 'advanced', paths: [['fall_distance'], ['FallDistance']] },
	{ key: 'slot', label: 'Selected hotbar slot', group: 'advanced', paths: [['SelectedItemSlot']], hint: '0 to 8.' },
	{ key: 'yaw', label: 'Facing (yaw)', group: 'advanced', paths: [['Rotation', 0]] },
	{ key: 'pitch', label: 'Looking up/down (pitch)', group: 'advanced', paths: [['Rotation', 1]] },
	{ key: 'spawn', label: 'Spawn point (x, y, z)', group: 'advanced', paths: [['respawn', 'pos']] },
	{ key: 'spawnX', label: 'Spawn X', group: 'advanced', paths: [['SpawnX']] },
	{ key: 'spawnY', label: 'Spawn Y', group: 'advanced', paths: [['SpawnY']] },
	{ key: 'spawnZ', label: 'Spawn Z', group: 'advanced', paths: [['SpawnZ']] },
	{ key: 'spawnDimension', label: 'Spawn dimension', group: 'advanced', paths: [['respawn', 'dimension'], ['SpawnDimension']] },
	{ key: 'spawnForced', label: 'Spawn even without a bed', group: 'advanced', paths: [['respawn', 'forced'], ['SpawnForced']], kind: 'checkbox' }
];

export function tagAt(root: Tag, path: Path): Tag | undefined {
	let tag: Tag | undefined = root;
	for (const key of path) {
		if (tag?.type === 'compound' && typeof key === 'string') tag = child(tag, key);
		else if (tag?.type === 'list' && typeof key === 'number') tag = tag.value[key];
		else return undefined;
	}
	return tag;
}

const NUMERIC = new Set<TagType>(['byte', 'short', 'int', 'long', 'float', 'double']);

/** A primitive's value for an input, or null for a tag no input can edit. */
function inputValue(tag: Tag, kind: FieldKind): string | boolean | null {
	if (kind === 'checkbox') return NUMERIC.has(tag.type) ? num(tag) !== 0 : null;
	if (tag.type === 'float') return String(shortestFloat(tag.value));
	if (tag.type === 'long') return String(tag.value);
	if (tag.type === 'byteArray' || tag.type === 'intArray' || tag.type === 'longArray') return tag.value.join(', ');
	if (tag.type === 'list' || tag.type === 'compound') return null;
	return String(tag.value);
}

function fieldFor(root: Compound, def: FieldDef): FieldView | null {
	for (const path of def.paths) {
		const tag = tagAt(root, path);
		if (!tag) continue;
		// Before 1.16 the dimension is a number.
		const options = def.key === 'dimension' && tag.type !== 'string' ? OLD_DIMENSIONS : def.options;
		const kind = def.key === 'dimension' && tag.type !== 'string' ? 'select' : (def.kind ?? (tag.type === 'string' ? 'text' : 'number'));
		const value = inputValue(tag, kind);
		if (value === null) return null;
		return { key: def.key, label: def.label, group: def.group, kind, path, type: tag.type, value, options, hint: def.hint };
	}
	return null;
}

/** Attribute base values (max health, movement speed...), named by their id. */
function attributeFields(root: Compound): FieldView[] {
	for (const key of ['attributes', 'Attributes']) {
		const list = child(root, key);
		if (list?.type !== 'list') continue;
		return list.value.flatMap((entry, i): FieldView[] => {
			const name = child(entry, 'id') ?? child(entry, 'Name');
			const baseKey = child(entry, 'base') ? 'base' : 'Base';
			const base = child(entry, baseKey);
			if (name?.type !== 'string' || !base || !NUMERIC.has(base.type)) return [];
			const id = name.value.replace(/^minecraft:/, '').replace(/^generic\./, '').replace(/^player\./, '');
			return [{ key: `attr:${name.value}`, label: id.replace(/[._]/g, ' '), group: 'attributes', kind: 'number', path: [key, i, baseKey], type: base.type, value: inputValue(base, 'number') as string }];
		});
	}
	return [];
}

export function playerFields(root: Compound): FieldView[] {
	return [...FIELDS.map((def) => fieldFor(root, def)).filter((f): f is FieldView => !!f), ...attributeFields(root)];
}

/** A checkbox's or input's value as the text a `set` edit takes. */
export function fieldEditValue(kind: FieldKind, value: string | boolean): string {
	return kind === 'checkbox' ? (value ? '1' : '0') : String(value);
}

// ---------------------------------------------------------------- effects ---

/** The numeric effect ids used up to 1.20.1. */
export const LEGACY_EFFECTS: Record<number, string> = {
	1: 'speed', 2: 'slowness', 3: 'haste', 4: 'mining_fatigue', 5: 'strength', 6: 'instant_health', 7: 'instant_damage',
	8: 'jump_boost', 9: 'nausea', 10: 'regeneration', 11: 'resistance', 12: 'fire_resistance', 13: 'water_breathing',
	14: 'invisibility', 15: 'blindness', 16: 'night_vision', 17: 'hunger', 18: 'weakness', 19: 'poison', 20: 'wither',
	21: 'health_boost', 22: 'absorption', 23: 'saturation', 24: 'glowing', 25: 'levitation', 26: 'luck', 27: 'unluck',
	28: 'slow_falling', 29: 'conduit_power', 30: 'dolphins_grace', 31: 'bad_omen', 32: 'hero_of_the_village', 33: 'darkness'
};

/** 1.20.2 moved effects to `active_effects` with string ids. */
const STRING_EFFECTS = 3578;

export type EffectView = {
	/** The effect's entry, for edits. */
	path: Path;
	id: string;
	/** Amplifier + 1, as the game shows it. */
	level: number;
	/** Seconds left; -1 forever. */
	seconds: number;
	levelPath: Path;
	durationPath: Path;
};

export type EffectsView = { list: 'active_effects' | 'ActiveEffects'; numericIds: boolean; effects: EffectView[] };

export function playerEffects(root: Compound, dataVersion: number | null): EffectsView {
	const existing = child(root, 'active_effects') ? 'active_effects' : child(root, 'ActiveEffects') ? 'ActiveEffects' : null;
	const list = existing ? child(root, existing) : undefined;
	// Entries already there decide (a mod or an upgrade can leave the old form behind), then the version.
	const first = list?.type === 'list' ? list.value[0] : undefined;
	const numericIds = first ? !child(first, 'id') : existing ? existing === 'ActiveEffects' : (dataVersion ?? 0) < STRING_EFFECTS;
	const listKey = existing ?? (numericIds ? 'ActiveEffects' : 'active_effects');
	const effects: EffectView[] = [];
	if (list?.type === 'list') {
		list.value.forEach((entry, i) => {
			const idTag = child(entry, 'id') ?? child(entry, 'Id');
			const ampKey = child(entry, 'amplifier') ? 'amplifier' : 'Amplifier';
			const durKey = child(entry, 'duration') ? 'duration' : 'Duration';
			const id = idTag?.type === 'string' ? idTag.value : idTag ? (LEGACY_EFFECTS[num(idTag)!] ? `minecraft:${LEGACY_EFFECTS[num(idTag)!]}` : String(num(idTag))) : '?';
			const ticks = num(child(entry, durKey)) ?? 0;
			effects.push({
				path: [listKey, i],
				id,
				level: (num(child(entry, ampKey)) ?? 0) + 1,
				seconds: ticks < 0 ? -1 : Math.round(ticks / 20),
				levelPath: [listKey, i, ampKey],
				durationPath: [listKey, i, durKey]
			});
		});
	}
	return { list: listKey, numericIds, effects };
}

/** Add an effect in the file's own format. */
export function addEffect(root: Compound, dataVersion: number | null, effect: { id: string; level: number; seconds: number }): void {
	const { list: key, numericIds } = playerEffects(root, dataVersion);
	const id = effect.id.trim();
	if (!Number.isInteger(effect.level) || effect.level < 1 || effect.level > 128) throw new PlayerDataError('Effect levels go from 1 to 128.');
	if (!Number.isInteger(effect.seconds) || effect.seconds < -1 || effect.seconds > 100_000_000) throw new PlayerDataError('Give the duration in seconds, or -1 for forever.');
	let idTag: Tag;
	if (numericIds) {
		const name = id.replace(/^minecraft:/, '');
		const number = /^\d+$/.test(name) ? Number(name) : Number(Object.entries(LEGACY_EFFECTS).find(([, n]) => n === name)?.[0]);
		if (!Number.isInteger(number) || number < 1 || number > 255) throw new PlayerDataError(`"${id}" is not an effect this version knows (like minecraft:speed, or its number).`);
		idTag = { type: 'byte', value: number > 127 ? number - 256 : number };
	} else {
		if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id)) throw new PlayerDataError(`"${id}" is not an effect id (like minecraft:speed).`);
		idTag = { type: 'string', value: id };
	}
	const names = numericIds
		? { id: 'Id', amplifier: 'Amplifier', duration: 'Duration', ambient: 'Ambient', particles: 'ShowParticles', icon: 'ShowIcon' }
		: { id: 'id', amplifier: 'amplifier', duration: 'duration', ambient: 'ambient', particles: 'show_particles', icon: 'show_icon' };
	const entry: Compound = {
		type: 'compound',
		value: [
			[names.id, idTag],
			[names.amplifier, { type: 'byte', value: effect.level - 1 }],
			[names.duration, { type: 'int', value: effect.seconds < 0 ? -1 : effect.seconds * 20 }],
			[names.ambient, { type: 'byte', value: 0 }],
			[names.particles, { type: 'byte', value: 1 }],
			[names.icon, { type: 'byte', value: 1 }]
		]
	};
	let list = child(root, key);
	if (list?.type !== 'list') {
		list = { type: 'list', itemType: 'compound', value: [] };
		setChild(root, key, list);
	}
	list.itemType = 'compound';
	list.value.push(entry);
}

// ---------------------------------------------------------- mapped fields ---

export type CustomKind = 'number' | 'checkbox' | 'text';
const KINDS: CustomKind[] = ['number', 'checkbox', 'text'];

export type CustomField = { id: number; label: string; path: Path; kind: CustomKind };

export type CustomFieldView = CustomField & {
	/** Null when this player's file has nothing usable at the path (or something of another kind). */
	field: FieldView | null;
	/** Why it is greyed out. */
	problem: string | null;
};

function checkPath(path: unknown): Path {
	if (!Array.isArray(path) || path.length === 0 || path.length > 64 || !path.every((k) => typeof k === 'string' || (typeof k === 'number' && Number.isInteger(k) && k >= 0))) {
		throw new PlayerDataError('That is not a place in the player data.');
	}
	return path as Path;
}

function checkField(label: string, kind: string): { label: string; kind: CustomKind } {
	const clean = label.trim().slice(0, 60);
	if (!clean) throw new PlayerDataError('Give the field a name.');
	if (!KINDS.includes(kind as CustomKind)) throw new PlayerDataError('Pick how the field is shown.');
	return { label: clean, kind: kind as CustomKind };
}

export function listCustomFields(instanceId: string): CustomField[] {
	return db
		.select()
		.from(playerFieldsTable)
		.where(eq(playerFieldsTable.instanceId, instanceId))
		.orderBy(playerFieldsTable.id)
		.all()
		.map((row) => ({ id: row.id, label: row.label, path: JSON.parse(row.path) as Path, kind: row.kind as CustomKind }));
}

export function addCustomField(instanceId: string, input: { label: string; path: unknown; kind: string }): void {
	const { label, kind } = checkField(input.label, input.kind);
	db.insert(playerFieldsTable)
		.values({ instanceId, label, kind, path: JSON.stringify(checkPath(input.path)), createdAt: Date.now() })
		.run();
}

/** Point a field at another place, keeping its name (and kind, unless a new one is given). */
export function remapCustomField(instanceId: string, id: number, path: unknown, kind?: string): void {
	const found = listCustomFields(instanceId).find((f) => f.id === id);
	if (!found) throw new PlayerDataError('That field no longer exists.');
	const next = kind ? checkField(found.label, kind).kind : found.kind;
	db.update(playerFieldsTable)
		.set({ path: JSON.stringify(checkPath(path)), kind: next })
		.where(and(eq(playerFieldsTable.instanceId, instanceId), eq(playerFieldsTable.id, id)))
		.run();
}

export function removeCustomField(instanceId: string, id: number): void {
	db.delete(playerFieldsTable).where(and(eq(playerFieldsTable.instanceId, instanceId), eq(playerFieldsTable.id, id))).run();
}

export function copyCustomFields(fromId: string, toId: string): void {
	for (const field of listCustomFields(fromId)) {
		db.insert(playerFieldsTable).values({ instanceId: toId, label: field.label, kind: field.kind, path: JSON.stringify(field.path), createdAt: Date.now() }).run();
	}
}

/** Each mapped field against this player's file. */
export function customFieldViews(root: Compound, fields: CustomField[]): CustomFieldView[] {
	return fields.map((f) => {
		const tag = tagAt(root, f.path);
		if (!tag) return { ...f, field: null, problem: 'This player’s data has nothing there.' };
		const value = inputValue(tag, f.kind);
		if (value === null || (f.kind === 'number' && !NUMERIC.has(tag.type))) {
			return { ...f, field: null, problem: `There is a ${tag.type} there now, which a ${f.kind} field cannot show.` };
		}
		return {
			...f,
			problem: null,
			field: { key: `custom:${f.id}`, label: f.label, group: 'basic', kind: f.kind, path: f.path, type: tag.type, value }
		};
	});
}

