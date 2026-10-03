import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerInstance } from './db/schema';
import { child, num, parseNbt, removeChild, setChild, shortestFloat, writeNbt, NbtError, type Compound, type NbtFile, type Tag, type TagType } from './nbt';
import { serverWorldName } from './packworld';
import { parseSnbt, SnbtError } from './snbt';
import {
	checkItem,
	describeItem,
	findContainers,
	LEGACY_ENCHANTMENTS,
	PlayerDataError,
	setContainerItem,
	countStyle,
	setCount,
	setDamage,
	setKeyedItem,
	styleOf,
	writeFields,
	type ContainerView,
	type Format,
	type ItemFields,
	type ItemView,
	type Section,
	type Style
} from './playeritems';
import { addEffect, LIST_ITEMS, playerEffects, playerFields, type EffectsView, type FieldView } from './playerfields';
import type { Path, TreeTag } from '$lib/shared/nbt';

export type { Path, TreeTag };
import { rconPassword } from './instances';
import { rconExec } from './rcon';
import { unitState } from './systemd';

/**
 * Player data: `<world>/playerdata/<uuid>.dat`, one NBT file per player who
 * has joined. The server reads it when the player joins and writes it while
 * they play and when they leave - so an online player is never edited (the
 * server would overwrite the change), and a file that changed since it was
 * opened is not written over.
 *
 * Item layout depends on the file's own DataVersion, not the server's:
 * - before 1.13 (1519): `Count` byte and a numeric `Damage`
 * - 1.13 to 1.20.4: `Count` byte, extra data under `tag`
 * - 1.20.5 (3837) on: `count` int, extra data under `components`
 * - 1.21.5 (4325) on: armor and offhand under `equipment`, not in `Inventory`
 *
 * Every save keeps the previous file in `.mineshell/playerdata-backups/`
 * (at most one per editing session, the newest 10 per player).
 */

export { PlayerDataError, shortestFloat };
export type { ContainerView, Format, ItemFields, ItemView, Section };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EQUIPMENT = 4325;

/** Inventory slot numbers for armor and offhand, as the pre-1.21.5 Inventory list has them. */
export const ARMOR_SLOTS = { 103: 'head', 102: 'chest', 101: 'legs', 100: 'feet' } as const;
export const OFFHAND_SLOT = -106;

// ------------------------------------------------------------------ files ---

async function playerDir(instance: ServerInstance): Promise<string> {
	return path.join(instance.path, await serverWorldName(instance.path), 'playerdata');
}

function checkUuid(uuid: string): string {
	if (!UUID.test(uuid)) throw new PlayerDataError('That is not a player id.');
	return uuid.toLowerCase();
}

const backupDir = (instance: ServerInstance, uuid: string) =>
	path.join(instance.path, '.mineshell', 'playerdata-backups', uuid);

/** Names from the server's usercache.json, by lower-case UUID. */
async function knownNames(instance: ServerInstance): Promise<Map<string, string>> {
	try {
		const cache = JSON.parse(await fs.readFile(path.join(instance.path, 'usercache.json'), 'utf8')) as { uuid: string; name: string }[];
		return new Map(cache.filter((e) => e?.uuid && e?.name).map((e) => [e.uuid.toLowerCase(), e.name]));
	} catch {
		return new Map();
	}
}

export type PlayerFile = { uuid: string; name: string | null; modifiedAt: number; size: number };

export async function listPlayerData(instance: ServerInstance): Promise<PlayerFile[]> {
	const dir = await playerDir(instance);
	const names = await knownNames(instance);
	const found: PlayerFile[] = [];
	for (const entry of await fs.readdir(dir).catch(() => [] as string[])) {
		const uuid = entry.replace(/\.dat$/, '').toLowerCase();
		if (!entry.endsWith('.dat') || !UUID.test(uuid)) continue;
		const stat = await fs.stat(path.join(dir, entry)).catch(() => null);
		if (stat?.isFile()) found.push({ uuid, name: names.get(uuid) ?? null, modifiedAt: stat.mtimeMs, size: stat.size });
	}
	return found.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * UUIDs of the players online, or null when the server is running and
 * cannot say (RCON not answering, or a name that maps to no UUID): then
 * nobody can be edited safely. Empty while the server is stopped.
 */
export async function onlinePlayerIds(instance: ServerInstance): Promise<Set<string> | null> {
	const state = await unitState(instance.id);
	if (state.active === 'inactive' || state.active === 'failed') return new Set();
	const password = rconPassword(instance);
	if (!password) return null;
	try {
		// `list uuids` (1.13+) names each player's UUID; older servers answer
		// with names only, which usercache.json maps.
		const [answer] = await rconExec({ port: instance.rconPort, password }, ['list uuids']);
		const ids = new Set([...answer.matchAll(/\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi)].map((m) => m[1].toLowerCase()));
		const counted = answer.match(/There are (\d+)/i);
		if (counted && ids.size >= Number(counted[1])) return ids;
		const [plain] = await rconExec({ port: instance.rconPort, password }, ['list']);
		// An answer that is not a player list says nothing about who is online.
		if (!/There are \d+/i.test(plain)) return null;
		const byName = new Map([...(await knownNames(instance))].map(([uuid, name]) => [name.toLowerCase(), uuid]));
		const names = (plain.split(':').slice(1).join(':') || '').split(',').map((n) => n.trim()).filter(Boolean);
		for (const name of names) {
			const uuid = byName.get(name.toLowerCase());
			if (!uuid) return null;
			ids.add(uuid);
		}
		return ids;
	} catch {
		return null;
	}
}

const versionOf = (bytes: Buffer) => crypto.createHash('sha1').update(bytes).digest('hex');

export async function readPlayerData(
	instance: ServerInstance,
	uuid: string
): Promise<{ file: NbtFile; version: string; name: string | null }> {
	const id = checkUuid(uuid);
	const bytes = await fs.readFile(path.join(await playerDir(instance), `${id}.dat`)).catch(() => null);
	if (!bytes) throw new PlayerDataError('This server has no saved data for that player.');
	try {
		return { file: parseNbt(bytes), version: versionOf(bytes), name: (await knownNames(instance)).get(id) ?? null };
	} catch (err) {
		throw new PlayerDataError(`The player file could not be read: ${err instanceof Error ? err.message : 'unknown error'}`);
	}
}

// ------------------------------------------------------------------- view ---

export function toTree(tag: Tag): TreeTag {
	switch (tag.type) {
		case 'long':
			return { type: 'long', value: String(tag.value) };
		case 'longArray':
			return { type: 'longArray', value: tag.value.map(String) };
		case 'float':
			return { type: 'float', value: Number.isFinite(tag.value) ? shortestFloat(tag.value) : String(tag.value) };
		case 'double':
			return { type: 'double', value: Number.isFinite(tag.value) ? tag.value : String(tag.value) };
		case 'list':
			return { type: 'list', itemType: tag.itemType, value: tag.value.map(toTree) };
		case 'compound':
			return { type: 'compound', value: tag.value.map(([k, v]) => [k, toTree(v)]) };
		default:
			return tag as TreeTag;
	}
}

export type PlayerView = {
	dataVersion: number | null;
	format: Format;
	/** Armor and offhand in `equipment` (1.21.5+) rather than in `Inventory`. */
	equipment: boolean;
	/** Built-in fields the file has values for (stats, abilities, spawn, attributes). */
	fields: FieldView[];
	effects: EffectsView;
	items: ItemView[];
	/** Other item lists in the file: Curios, Trinkets and other mod slots. */
	containers: ContainerView[];
	/** 1.12's enchantment numbers and their names, for the item editor; empty for newer files. */
	legacyEnchantments: Record<number, string>;
	tree: TreeTag;
};

export function formatOf(dataVersion: number | null): Format {
	return styleOf(dataVersion).format;
}

function usesEquipment(root: Compound, dataVersion: number | null): boolean {
	return child(root, 'equipment')?.type === 'compound' || (dataVersion ?? 0) >= EQUIPMENT;
}

function sectionOf(slot: number): Section {
	if (slot >= 0 && slot <= 35) return 'main';
	if (slot in ARMOR_SLOTS) return 'armor';
	return slot === OFFHAND_SLOT ? 'offhand' : 'other';
}

export function playerView(file: NbtFile): PlayerView {
	const root = file.root;
	const dataVersion = num(child(root, 'DataVersion'));
	const style = styleOf(dataVersion);
	const format = style.format;
	const equipment = usesEquipment(root, dataVersion);
	const items: ItemView[] = [];

	const inventory = child(root, 'Inventory');
	if (inventory?.type === 'list') {
		inventory.value.forEach((item, i) => {
			const slot = num(child(item, 'Slot'));
			if (slot === null) return;
			const view = describeItem(item, sectionOf(slot), slot, ['Inventory', i], style);
			if (view) items.push(view);
		});
	}
	const ender = child(root, 'EnderItems');
	if (ender?.type === 'list') {
		ender.value.forEach((item, i) => {
			const slot = num(child(item, 'Slot'));
			const view = slot === null ? null : describeItem(item, 'ender', slot, ['EnderItems', i], style);
			if (view) items.push(view);
		});
	}
	const worn = child(root, 'equipment');
	if (worn?.type === 'compound') {
		for (const [key, item] of worn.value) {
			const slot = key === 'offhand' ? OFFHAND_SLOT : Number(Object.entries(ARMOR_SLOTS).find(([, k]) => k === key)?.[0] ?? NaN);
			if (Number.isNaN(slot)) continue;
			const view = describeItem(item, slot === OFFHAND_SLOT ? 'offhand' : 'armor', slot, ['equipment', key], style);
			if (view) items.push(view);
		}
	}

	return {
		dataVersion,
		format,
		equipment,
		fields: playerFields(root),
		effects: playerEffects(root, dataVersion),
		items,
		containers: findContainers(root, [], style, '', 0, new Set(['Inventory', 'EnderItems', 'equipment'])),
		legacyEnchantments: style.format === 'legacy' ? LEGACY_ENCHANTMENTS : {},
		tree: toTree(root)
	};
}

// ------------------------------------------------------------------ edits ---

export type Edit =
	/** A new value; with `type`, also a new type (a value in a compound only). */
	| { op: 'set'; path: Path; value: string; type?: TagType }
	| { op: 'remove'; path: Path }
	/** `type: 'snbt'` takes a whole structure as text. */
	| { op: 'add'; path: Path; name?: string; type: TagType | 'snbt'; value?: string }
	/** Replace any entry, compounds and lists included, with SNBT. */
	| { op: 'replace'; path: Path; snbt: string }
	| { op: 'rename'; path: Path; name: string }
	| { op: 'item'; section: Section; slot: number; id: string; count: number; damage?: number | null }
	| { op: 'removeItem'; section: Section; slot: number }
	/** An item in a container (shulker box, bundle, backpack): `list` is the list holding it. */
	| { op: 'containerItem'; list: Path; slot: number; id: string; count: number; damage?: number | null }
	| { op: 'containerRemove'; list: Path; slot: number }
	/** Name, lore, enchantments, unbreakable, durability of the item at `item`. */
	| { op: 'itemFields'; item: Path; fields: Partial<Omit<ItemFields, 'stored'>> }
	| { op: 'addEffect'; id: string; level: number; seconds: number }
	/** A list of plain values, all entries at once (a list field). */
	| { op: 'setList'; path: Path; values: string[] };

const SECTIONS: Section[] = ['main', 'armor', 'offhand', 'ender'];
const isPath = (p: unknown): p is Path =>
	Array.isArray(p) && p.every((k) => typeof k === 'string' || (typeof k === 'number' && Number.isInteger(k)));

/** Edits as the browser sent them, checked for shape (values are checked when applied). */
export function parseEdits(raw: unknown): Edit[] {
	if (!Array.isArray(raw)) throw new PlayerDataError('That change could not be read.');
	return raw.map((e): Edit => {
		const bad = () => new PlayerDataError('That change could not be read.');
		if (!e || typeof e !== 'object') throw bad();
		switch (e.op) {
			case 'set':
				if (!isPath(e.path) || typeof e.value !== 'string' || (e.type !== undefined && !TAG_TYPES.has(e.type))) throw bad();
				return { op: 'set', path: e.path, value: e.value, ...(e.type ? { type: e.type } : {}) };
			case 'replace':
				if (!isPath(e.path) || typeof e.snbt !== 'string') throw bad();
				return { op: 'replace', path: e.path, snbt: e.snbt };
			case 'rename':
				if (!isPath(e.path) || typeof e.name !== 'string') throw bad();
				return { op: 'rename', path: e.path, name: e.name };
			case 'remove':
				if (!isPath(e.path)) throw bad();
				return { op: 'remove', path: e.path };
			case 'add':
				if (!isPath(e.path) || !(TAG_TYPES.has(e.type) || e.type === 'snbt')) throw bad();
				return { op: 'add', path: e.path, type: e.type, name: String(e.name ?? ''), value: String(e.value ?? '') };
			case 'item':
				if (!SECTIONS.includes(e.section) || !Number.isInteger(e.slot) || typeof e.id !== 'string' || typeof e.count !== 'number') throw bad();
				return { op: 'item', section: e.section, slot: e.slot, id: e.id, count: e.count, damage: typeof e.damage === 'number' ? e.damage : null };
			case 'removeItem':
				if (!SECTIONS.includes(e.section) || !Number.isInteger(e.slot)) throw bad();
				return { op: 'removeItem', section: e.section, slot: e.slot };
			case 'containerItem':
				if (!isPath(e.list) || !Number.isInteger(e.slot) || typeof e.id !== 'string' || typeof e.count !== 'number') throw bad();
				return { op: 'containerItem', list: e.list, slot: e.slot, id: e.id, count: e.count, damage: typeof e.damage === 'number' ? e.damage : null };
			case 'containerRemove':
				if (!isPath(e.list) || !Number.isInteger(e.slot)) throw bad();
				return { op: 'containerRemove', list: e.list, slot: e.slot };
			case 'setList':
				if (!isPath(e.path) || !Array.isArray(e.values) || !e.values.every((v: unknown) => typeof v === 'string')) throw bad();
				return { op: 'setList', path: e.path, values: e.values };
			case 'addEffect':
				if (typeof e.id !== 'string' || typeof e.level !== 'number' || typeof e.seconds !== 'number') throw bad();
				return { op: 'addEffect', id: e.id, level: e.level, seconds: e.seconds };
			case 'itemFields':
				if (!isPath(e.item) || !e.fields || typeof e.fields !== 'object') throw bad();
				return { op: 'itemFields', item: e.item, fields: itemFieldsFrom(e.fields, bad) };
			default:
				throw bad();
		}
	});
}

function itemFieldsFrom(raw: Record<string, unknown>, bad: () => Error): Partial<Omit<ItemFields, 'stored'>> {
	const out: Partial<Omit<ItemFields, 'stored'>> = {};
	if ('name' in raw) {
		if (raw.name !== null && typeof raw.name !== 'string') throw bad();
		out.name = raw.name as string | null;
	}
	if ('lore' in raw) {
		if (!Array.isArray(raw.lore) || !raw.lore.every((l) => typeof l === 'string')) throw bad();
		out.lore = raw.lore as string[];
	}
	if ('enchantments' in raw) {
		const list = raw.enchantments;
		if (!Array.isArray(list) || !list.every((e) => e && typeof e.id === 'string' && typeof e.level === 'number')) throw bad();
		out.enchantments = list.map((e) => ({ id: e.id.trim(), level: e.level }));
	}
	if ('unbreakable' in raw) {
		if (typeof raw.unbreakable !== 'boolean') throw bad();
		out.unbreakable = raw.unbreakable;
	}
	if ('damage' in raw) {
		if (raw.damage !== null && typeof raw.damage !== 'number') throw bad();
		out.damage = raw.damage as number | null;
	}
	return out;
}

const TAG_TYPES = new Set<TagType>(['byte', 'short', 'int', 'long', 'float', 'double', 'string', 'byteArray', 'intArray', 'longArray', 'list', 'compound']);

const RANGES: Partial<Record<TagType, [number, number]>> = {
	byte: [-128, 127],
	short: [-32768, 32767],
	int: [-2147483648, 2147483647]
};

function integer(raw: string, type: TagType): number {
	const text = raw.trim();
	const [min, max] = RANGES[type]!;
	if (!/^-?\d+$/.test(text) || Number(text) < min || Number(text) > max) {
		throw new PlayerDataError(`"${raw}" is not a whole number between ${min} and ${max}.`);
	}
	return Number(text);
}

function bigint(raw: string): bigint {
	const text = raw.trim();
	if (!/^-?\d+$/.test(text)) throw new PlayerDataError(`"${raw}" is not a whole number.`);
	const value = BigInt(text);
	if (value < -(2n ** 63n) || value >= 2n ** 63n) throw new PlayerDataError(`"${raw}" is out of range for a long.`);
	return value;
}

function decimal(raw: string): number {
	const value = Number(raw.trim());
	if (raw.trim() === '' || !Number.isFinite(value)) throw new PlayerDataError(`"${raw}" is not a number.`);
	return value;
}

const parts = (raw: string) => raw.split(/[\s,]+/).filter(Boolean);

/** A tag of `type` from the text typed into the editor. Lists and compounds start empty. */
export function parseValue(type: TagType, raw = ''): Tag {
	switch (type) {
		case 'byte':
		case 'short':
		case 'int':
			return { type, value: integer(raw, type) };
		case 'long':
			return { type, value: bigint(raw) };
		case 'float':
		case 'double':
			return { type, value: decimal(raw) };
		case 'string':
			return { type, value: raw };
		case 'byteArray':
		case 'intArray':
			return { type, value: parts(raw).map((p) => integer(p, type === 'byteArray' ? 'byte' : 'int')) };
		case 'longArray':
			return { type, value: parts(raw).map(bigint) };
		case 'list':
			return { type, itemType: 'end', value: [] };
		case 'compound':
			return { type, value: [] };
		default:
			throw new PlayerDataError(`Cannot create a ${type} tag.`);
	}
}

/** The tag at `at`, plus how to replace or remove it in its parent. */
function locate(
	root: Compound,
	at: Path
): { tag: Tag; parent: Tag; key: string | number; replace: (t: Tag) => void; remove: () => void } {
	if (at.length === 0) throw new PlayerDataError('The root cannot be changed.');
	let parent: Tag = root;
	for (let i = 0; i < at.length - 1; i++) parent = step(parent, at[i]);
	const key = at[at.length - 1];
	const tag = step(parent, key);
	const p = parent;
	return {
		tag,
		parent: p,
		key,
		replace: (t) => (p.type === 'compound' ? setChild(p, String(key), t) : ((p as Extract<Tag, { type: 'list' }>).value[key as number] = t)),
		remove: () => (p.type === 'compound' ? removeChild(p, String(key)) : (p as Extract<Tag, { type: 'list' }>).value.splice(key as number, 1))
	};
}

function step(tag: Tag, key: string | number): Tag {
	if (tag.type === 'compound' && typeof key === 'string') {
		const found = child(tag, key);
		if (found) return found;
	}
	if (tag.type === 'list' && typeof key === 'number' && key >= 0 && key < tag.value.length) return tag.value[key];
	throw new PlayerDataError('That entry is no longer there. Reload the page and try again.');
}

/** Where an item for (section, slot) lives: a list and the slot number in it, or an equipment key. */
function itemHome(root: Compound, section: Section, slot: number, equipment: boolean) {
	if (section === 'ender') {
		if (slot < 0 || slot > 26) throw new PlayerDataError('The ender chest has slots 0 to 26.');
		return { list: 'EnderItems' as const, slot };
	}
	if (section === 'main') {
		if (slot < 0 || slot > 35) throw new PlayerDataError('The inventory has slots 0 to 35.');
		return { list: 'Inventory' as const, slot };
	}
	const key = section === 'offhand' ? 'offhand' : ARMOR_SLOTS[slot as keyof typeof ARMOR_SLOTS];
	if (!key || (section === 'offhand') !== (slot === OFFHAND_SLOT)) throw new PlayerDataError('No such armor slot.');
	return equipment ? { equipment: key } : { list: 'Inventory' as const, slot };
}

function listOf(root: Compound, name: string): Extract<Tag, { type: 'list' }> {
	let list = child(root, name);
	if (list?.type !== 'list') {
		list = { type: 'list', itemType: 'compound', value: [] };
		setChild(root, name, list);
	}
	if (list.itemType === 'end') list.itemType = 'compound';
	return list;
}

function applyItem(root: Compound, edit: Extract<Edit, { op: 'item' | 'removeItem' }>, style: Style, equipment: boolean): void {
	const format = style.format;
	const home = itemHome(root, edit.section, edit.slot, equipment);
	let existing: Compound | undefined;
	let dropExisting: () => void = () => undefined;
	let place: (item: Compound) => void;
	let neighbours: Tag[] = [];

	if ('equipment' in home && home.equipment) {
		let worn = child(root, 'equipment');
		if (worn?.type !== 'compound') {
			worn = { type: 'compound', value: [] };
			setChild(root, 'equipment', worn);
		}
		const holder = worn;
		const found = child(holder, home.equipment);
		existing = found?.type === 'compound' ? found : undefined;
		neighbours = holder.value.map(([, v]) => v);
		dropExisting = () => removeChild(holder, home.equipment);
		place = (item) => setChild(holder, home.equipment, item);
	} else {
		const list = listOf(root, home.list!);
		const at = list.value.findIndex((i) => num(child(i, 'Slot')) === home.slot);
		neighbours = list.value;
		existing = at >= 0 && list.value[at].type === 'compound' ? (list.value[at] as Compound) : undefined;
		dropExisting = () => list.value.splice(at, 1);
		place = (item) => (at >= 0 ? (list.value[at] = item) : list.value.push(item));
	}

	if (edit.op === 'removeItem') {
		if (!existing) throw new PlayerDataError('That slot is already empty.');
		dropExisting();
		return;
	}

	const id = checkItem(edit.id, edit.count);

	// Changing an item keeps everything else on it (enchantments, names, NBT).
	const item: Compound = existing ?? { type: 'compound', value: [] };
	if (!existing && !('equipment' in home && home.equipment)) setChild(item, 'Slot', { type: 'byte', value: edit.slot });
	setChild(item, 'id', { type: 'string', value: id });
	// A new item stores its count like the items around it.
	const like = existing ? null : countStyle(neighbours);
	setCount(
		item,
		like?.key ?? (format === 'components' ? 'count' : 'Count'),
		like?.type ?? (format === 'components' ? 'int' : 'byte'),
		edit.count,
		style
	);
	setDamage(item, edit.damage, !existing, style);
	place(item);
}

function snbtValue(text: string): Tag {
	try {
		return parseSnbt(text);
	} catch (err) {
		throw new PlayerDataError(err instanceof SnbtError ? `That SNBT is not valid: ${err.message}.` : 'That SNBT is not valid.');
	}
}

/**
 * Edits apply in order, each path meaning the file as the edits before it
 * left it: removing entry 0 of a list twice removes its first two entries.
 * The page sends removals one at a time, so positions never shift under a
 * batch it sends.
 */
export function applyEdits(file: NbtFile, edits: Edit[]): void {
	const root = file.root;
	const dataVersion = num(child(root, 'DataVersion'));
	const style = styleOf(dataVersion);
	const equipment = usesEquipment(root, dataVersion);
	for (const edit of edits) {
		switch (edit.op) {
			case 'set': {
				const { tag, parent, replace } = locate(root, edit.path);
				if (tag.type === 'list' || tag.type === 'compound') throw new PlayerDataError('Lists and compounds are edited entry by entry.');
				const type = edit.type ?? tag.type;
				if (type !== tag.type && parent.type === 'list') throw new PlayerDataError('Every entry of a list has the same type.');
				replace(parseValue(type, edit.value));
				break;
			}
			case 'replace': {
				const { tag, parent, replace } = locate(root, edit.path);
				const value = snbtValue(edit.snbt);
				if (parent.type === 'list' && value.type !== tag.type) {
					if (parent.value.length > 1) throw new PlayerDataError(`This list holds ${parent.itemType} entries.`);
					parent.itemType = value.type;
				}
				replace(value);
				break;
			}
			case 'rename': {
				const { parent, key } = locate(root, edit.path);
				const name = edit.name.trim();
				if (parent.type !== 'compound') throw new PlayerDataError('Only entries of a compound have names.');
				if (!name) throw new PlayerDataError('Give the entry a name.');
				if (name !== key && child(parent, name)) throw new PlayerDataError(`There already is an entry called "${name}".`);
				const at = parent.value.findIndex(([n]) => n === key);
				parent.value[at] = [name, parent.value[at][1]];
				break;
			}
			case 'remove':
				locate(root, edit.path).remove();
				break;
			case 'add': {
				const parent = edit.path.length ? locate(root, edit.path).tag : root;
				const value = edit.type === 'snbt' ? snbtValue(edit.value ?? '') : parseValue(edit.type, edit.value);
				if (parent.type === 'compound') {
					const name = (edit.name ?? '').trim();
					if (!name) throw new PlayerDataError('Give the new entry a name.');
					if (child(parent, name)) throw new PlayerDataError(`There already is an entry called "${name}".`);
					parent.value.push([name, value]);
				} else if (parent.type === 'list') {
					if (parent.value.length && parent.itemType !== value.type) {
						throw new PlayerDataError(`This list holds ${parent.itemType} entries.`);
					}
					parent.itemType = value.type;
					parent.value.push(value);
				} else {
					throw new PlayerDataError('Entries can only be added to lists and compounds.');
				}
				break;
			}
			case 'item':
			case 'removeItem':
				applyItem(root, edit, style, equipment);
				break;
			case 'containerItem':
			case 'containerRemove': {
				const { tag, parent } = locate(root, edit.list);
				const item = edit.op === 'containerItem' ? edit : null;
				if (tag.type === 'list') setContainerItem(tag, parent, edit.list, edit.slot, item, style);
				else if (tag.type === 'compound') setKeyedItem(tag, edit.slot, item, style);
				else throw new PlayerDataError('That container is no longer there. Reload the page and try again.');
				break;
			}
			case 'addEffect':
				addEffect(root, dataVersion, edit);
				break;
			case 'setList': {
				const { tag } = locate(root, edit.path);
				if (tag.type !== 'list' || !LIST_ITEMS.has(tag.itemType)) throw new PlayerDataError('That is not a list of plain values any more. Reload the page.');
				// An empty list has no type yet: text, then.
				const type = tag.itemType === 'end' ? 'string' : tag.itemType;
				const values = edit.values.filter((v) => v.trim() !== '');
				tag.value = values.map((v) => parseValue(type, type === 'string' ? v : v.trim()));
				tag.itemType = tag.value.length ? type : 'end';
				break;
			}
			case 'itemFields': {
				const { tag } = locate(root, edit.item);
				if (tag.type !== 'compound' || !child(tag, 'id')) throw new PlayerDataError('That item is no longer there. Reload the page and try again.');
				writeFields(tag, edit.fields, style);
				break;
			}
		}
	}
	// A typo must fail here, not leave a file the server cannot read.
	try {
		parseNbt(writeNbt(file));
	} catch (err) {
		throw new PlayerDataError(err instanceof NbtError ? err.message : 'The change would make the file unreadable.');
	}
}

// ----------------------------------------------------------------- saving ---

/** One backup per editing session: a save within this long of the last backup adds none. */
const SESSION_MS = 10 * 60_000;
const KEEP_BACKUPS = 10;

export type Backup = { name: string; at: number; size: number };

export async function listBackups(instance: ServerInstance, uuid: string): Promise<Backup[]> {
	const dir = backupDir(instance, checkUuid(uuid));
	const out: Backup[] = [];
	for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
		if (!/^\d+\.dat$/.test(name)) continue;
		const stat = await fs.stat(path.join(dir, name)).catch(() => null);
		if (stat) out.push({ name, at: Number(name.slice(0, -4)), size: stat.size });
	}
	return out.sort((a, b) => b.at - a.at);
}

async function backUp(instance: ServerInstance, uuid: string, bytes: Buffer, force: boolean): Promise<void> {
	const existing = await listBackups(instance, uuid);
	if (!force && existing[0] && Date.now() - existing[0].at < SESSION_MS) return;
	const dir = backupDir(instance, uuid);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, `${Date.now()}.dat`), bytes);
	for (const old of (await listBackups(instance, uuid)).slice(KEEP_BACKUPS)) {
		await fs.rm(path.join(dir, old.name), { force: true });
	}
}

async function requireOffline(instance: ServerInstance, uuid: string, name: string | null): Promise<void> {
	const online = await onlinePlayerIds(instance);
	if (online === null) {
		throw new PlayerDataError(
			'The server is running and MineShell cannot tell who is online (RCON is not answering). Stop the server to edit player data.'
		);
	}
	if (online.has(uuid)) {
		throw new PlayerDataError(
			`${name ?? 'That player'} is online, and the server would overwrite the change when they leave. Edit once they have left.`
		);
	}
}

/**
 * Write `bytes` as the player's file: checked against `version`, previous
 * file backed up, replaced atomically. Whether the player is online is
 * asked once more right before the swap, with everything else done, so a
 * join between the first check and the write leaves as small a window as
 * the server allows (it can still join in the moment after; nothing can
 * close that from outside the server).
 */
async function replaceFile(instance: ServerInstance, uuid: string, name: string | null, version: string, bytes: Buffer, forceBackup: boolean): Promise<string> {
	const file = path.join(await playerDir(instance), `${uuid}.dat`);
	const current = await fs.readFile(file);
	if (versionOf(current) !== version) {
		throw new PlayerDataError('The file changed since you opened it (the player may have joined). Reload to see the current data.');
	}
	await backUp(instance, uuid, current, forceBackup);
	const tmp = `${file}.mineshell-tmp`;
	await fs.writeFile(tmp, bytes);
	try {
		await requireOffline(instance, uuid, name);
	} catch (err) {
		await fs.rm(tmp, { force: true });
		throw err;
	}
	await fs.rename(tmp, file);
	return versionOf(bytes);
}

/** Apply edits to the player's file. Returns the new version. */
export async function savePlayerData(instance: ServerInstance, uuid: string, version: string, edits: Edit[]): Promise<string> {
	const id = checkUuid(uuid);
	const { file, name } = await readPlayerData(instance, id);
	// Asked first too, so an online player is refused before any work.
	await requireOffline(instance, id, name);
	applyEdits(file, edits);
	return replaceFile(instance, id, name, version, writeNbt(file), false);
}

/** Put a backup back (the current file is backed up first). */
export async function restorePlayerBackup(instance: ServerInstance, uuid: string, version: string, backup: string): Promise<string> {
	const id = checkUuid(uuid);
	if (!/^\d+\.dat$/.test(backup)) throw new PlayerDataError('No such backup.');
	const bytes = await fs.readFile(path.join(backupDir(instance, id), backup)).catch(() => null);
	if (!bytes) throw new PlayerDataError('No such backup.');
	const { name } = await readPlayerData(instance, id);
	await requireOffline(instance, id, name);
	return replaceFile(instance, id, name, version, bytes, true);
}
