import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerInstance } from './db/schema';
import { child, num, parseNbt, removeChild, setChild, str, writeNbt, NbtError, type Compound, type NbtFile, type Tag, type TagType } from './nbt';
import { serverWorldName } from './packworld';
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

export class PlayerDataError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLATTENING = 1519;
const COMPONENTS = 3837;
const EQUIPMENT = 4325;

export type Path = (string | number)[];
export type Section = 'main' | 'armor' | 'offhand' | 'ender' | 'other';

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

/** A JSON-safe tag for the browser: longs as strings, non-finite floats as strings. */
export type TreeTag =
	| { type: 'byte' | 'short' | 'int' | 'float' | 'double'; value: number | string }
	| { type: 'long' | 'string'; value: string }
	| { type: 'byteArray' | 'intArray'; value: number[] }
	| { type: 'longArray'; value: string[] }
	| { type: 'list'; itemType: TagType; value: TreeTag[] }
	| { type: 'compound'; value: [string, TreeTag][] };

/** The shortest decimal that is the same 32-bit float: 0.1, not 0.10000000149011612. */
export function shortestFloat(value: number): number {
	for (let digits = 1; digits <= 9; digits++) {
		const candidate = Number(value.toPrecision(digits));
		if (Math.fround(candidate) === value) return candidate;
	}
	return value;
}

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

export type ItemView = {
	section: Section;
	slot: number;
	id: string;
	count: number;
	/** Pre-1.13 metadata/durability. */
	damage: number | null;
	/** A custom name, as plain text. */
	name: string | null;
	/** Enchantments, names, NBT or components beyond id and count. */
	hasData: boolean;
	/** Where the item's compound is in the tree. */
	path: Path;
};

export type Format = 'legacy' | 'flat' | 'components';

export type PlayerView = {
	dataVersion: number | null;
	format: Format;
	/** Armor and offhand in `equipment` (1.21.5+) rather than in `Inventory`. */
	equipment: boolean;
	stats: {
		health: number | null;
		food: number | null;
		saturation: number | null;
		xpLevel: number | null;
		xpProgress: number | null;
		gameMode: number | null;
		dimension: string | null;
		pos: number[] | null;
	};
	items: ItemView[];
	tree: TreeTag;
};

export function formatOf(dataVersion: number | null): Format {
	if (dataVersion === null || dataVersion < FLATTENING) return 'legacy';
	return dataVersion < COMPONENTS ? 'flat' : 'components';
}

function usesEquipment(root: Compound, dataVersion: number | null): boolean {
	return child(root, 'equipment')?.type === 'compound' || (dataVersion ?? 0) >= EQUIPMENT;
}

/** Text of a custom name: a JSON text component (1.13+), an NBT text component (1.21.5+) or plain (1.12). */
function nameText(tag: Tag | undefined): string | null {
	if (!tag) return null;
	if (tag.type === 'compound') return str(child(tag, 'text'));
	if (tag.type !== 'string') return null;
	try {
		const parsed = JSON.parse(tag.value);
		if (typeof parsed === 'string') return parsed;
		if (parsed && typeof parsed.text === 'string') return parsed.text + (Array.isArray(parsed.extra) ? parsed.extra.map((e: { text?: string } | string) => (typeof e === 'string' ? e : (e.text ?? ''))).join('') : '');
	} catch {
		/* plain text */
	}
	return tag.value;
}

function itemView(item: Tag, section: Section, slot: number, at: Path, format: Format): ItemView | null {
	if (item.type !== 'compound') return null;
	const idTag = child(item, 'id');
	const id = idTag?.type === 'string' ? idTag.value : idTag ? String(num(idTag)) : '';
	const count = format === 'components' ? (num(child(item, 'count')) ?? 1) : (num(child(item, 'Count')) ?? 1);
	const data = format === 'components' ? child(item, 'components') : child(item, 'tag');
	const name = format === 'components' ? nameText(child(child(item, 'components'), 'minecraft:custom_name')) : nameText(child(child(child(item, 'tag'), 'display'), 'Name'));
	return {
		section,
		slot,
		id,
		count,
		damage: format === 'legacy' ? num(child(item, 'Damage')) : null,
		name,
		hasData: data?.type === 'compound' ? data.value.length > 0 : !!data,
		path: at
	};
}

function sectionOf(slot: number): Section {
	if (slot >= 0 && slot <= 35) return 'main';
	if (slot in ARMOR_SLOTS) return 'armor';
	return slot === OFFHAND_SLOT ? 'offhand' : 'other';
}

function floatValue(tag: Tag | undefined): number | null {
	const value = num(tag);
	return value !== null && tag?.type === 'float' ? shortestFloat(value) : value;
}

export function playerView(file: NbtFile): PlayerView {
	const root = file.root;
	const dataVersion = num(child(root, 'DataVersion'));
	const format = formatOf(dataVersion);
	const equipment = usesEquipment(root, dataVersion);
	const items: ItemView[] = [];

	const inventory = child(root, 'Inventory');
	if (inventory?.type === 'list') {
		inventory.value.forEach((item, i) => {
			const slot = num(child(item, 'Slot'));
			if (slot === null) return;
			const view = itemView(item, sectionOf(slot), slot, ['Inventory', i], format);
			if (view) items.push(view);
		});
	}
	const ender = child(root, 'EnderItems');
	if (ender?.type === 'list') {
		ender.value.forEach((item, i) => {
			const slot = num(child(item, 'Slot'));
			const view = slot === null ? null : itemView(item, 'ender', slot, ['EnderItems', i], format);
			if (view) items.push(view);
		});
	}
	const worn = child(root, 'equipment');
	if (worn?.type === 'compound') {
		for (const [key, item] of worn.value) {
			const slot = key === 'offhand' ? OFFHAND_SLOT : Number(Object.entries(ARMOR_SLOTS).find(([, k]) => k === key)?.[0] ?? NaN);
			if (Number.isNaN(slot)) continue;
			const view = itemView(item, slot === OFFHAND_SLOT ? 'offhand' : 'armor', slot, ['equipment', key], format);
			if (view) items.push(view);
		}
	}

	const pos = child(root, 'Pos');
	const dimension = child(root, 'Dimension');
	return {
		dataVersion,
		format,
		equipment,
		stats: {
			health: floatValue(child(root, 'Health')),
			food: num(child(root, 'foodLevel')),
			saturation: floatValue(child(root, 'foodSaturationLevel')),
			xpLevel: num(child(root, 'XpLevel')),
			xpProgress: floatValue(child(root, 'XpP')),
			gameMode: num(child(root, 'playerGameType')),
			// A string since 1.16, a number (-1, 0, 1) before.
			dimension: dimension?.type === 'string' ? dimension.value : dimension ? String(num(dimension)) : null,
			pos: pos?.type === 'list' ? pos.value.map((p) => num(p) ?? 0) : null
		},
		items,
		tree: toTree(root)
	};
}

// ------------------------------------------------------------------ edits ---

export type Edit =
	| { op: 'set'; path: Path; value: string }
	| { op: 'remove'; path: Path }
	| { op: 'add'; path: Path; name?: string; type: TagType; value?: string }
	| { op: 'item'; section: Section; slot: number; id: string; count: number; damage?: number | null }
	| { op: 'removeItem'; section: Section; slot: number };

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
				if (!isPath(e.path) || typeof e.value !== 'string') throw bad();
				return { op: 'set', path: e.path, value: e.value };
			case 'remove':
				if (!isPath(e.path)) throw bad();
				return { op: 'remove', path: e.path };
			case 'add':
				if (!isPath(e.path) || !TAG_TYPES.has(e.type)) throw bad();
				return { op: 'add', path: e.path, type: e.type, name: String(e.name ?? ''), value: String(e.value ?? '') };
			case 'item':
				if (!SECTIONS.includes(e.section) || !Number.isInteger(e.slot) || typeof e.id !== 'string' || typeof e.count !== 'number') throw bad();
				return { op: 'item', section: e.section, slot: e.slot, id: e.id, count: e.count, damage: typeof e.damage === 'number' ? e.damage : null };
			case 'removeItem':
				if (!SECTIONS.includes(e.section) || !Number.isInteger(e.slot)) throw bad();
				return { op: 'removeItem', section: e.section, slot: e.slot };
			default:
				throw bad();
		}
	});
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
function locate(root: Compound, at: Path): { tag: Tag; replace: (t: Tag) => void; remove: () => void } {
	if (at.length === 0) throw new PlayerDataError('The root cannot be changed.');
	let parent: Tag = root;
	for (let i = 0; i < at.length - 1; i++) parent = step(parent, at[i]);
	const key = at[at.length - 1];
	const tag = step(parent, key);
	const p = parent;
	return {
		tag,
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

const ITEM_ID = /^[a-z0-9_.-]+:[a-zA-Z0-9_./-]+$/;

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

function applyItem(root: Compound, edit: Extract<Edit, { op: 'item' | 'removeItem' }>, format: Format, equipment: boolean): void {
	const home = itemHome(root, edit.section, edit.slot, equipment);
	let existing: Compound | undefined;
	let dropExisting: () => void = () => undefined;
	let place: (item: Compound) => void;

	if ('equipment' in home && home.equipment) {
		let worn = child(root, 'equipment');
		if (worn?.type !== 'compound') {
			worn = { type: 'compound', value: [] };
			setChild(root, 'equipment', worn);
		}
		const holder = worn;
		const found = child(holder, home.equipment);
		existing = found?.type === 'compound' ? found : undefined;
		dropExisting = () => removeChild(holder, home.equipment);
		place = (item) => setChild(holder, home.equipment, item);
	} else {
		const list = listOf(root, home.list!);
		const at = list.value.findIndex((i) => num(child(i, 'Slot')) === home.slot);
		existing = at >= 0 && list.value[at].type === 'compound' ? (list.value[at] as Compound) : undefined;
		dropExisting = () => list.value.splice(at, 1);
		place = (item) => (at >= 0 ? (list.value[at] = item) : list.value.push(item));
	}

	if (edit.op === 'removeItem') {
		if (!existing) throw new PlayerDataError('That slot is already empty.');
		dropExisting();
		return;
	}

	const id = edit.id.trim();
	if (!ITEM_ID.test(id)) throw new PlayerDataError(`"${edit.id}" is not an item id (like minecraft:diamond).`);
	const maxCount = format === 'components' ? 99 : 127;
	if (!Number.isInteger(edit.count) || edit.count < 1 || edit.count > maxCount) {
		throw new PlayerDataError(`The count must be between 1 and ${maxCount}.`);
	}

	// Changing an item keeps everything else on it (enchantments, names, NBT).
	const item: Compound = existing ?? { type: 'compound', value: [] };
	if (!existing && !('equipment' in home && home.equipment)) setChild(item, 'Slot', { type: 'byte', value: edit.slot });
	setChild(item, 'id', { type: 'string', value: id });
	if (format === 'components') setChild(item, 'count', { type: 'int', value: edit.count });
	else setChild(item, 'Count', { type: 'byte', value: edit.count });
	if (format === 'legacy') {
		const damage = edit.damage ?? num(child(item, 'Damage')) ?? 0;
		setChild(item, 'Damage', { type: 'short', value: integer(String(damage), 'short') });
	}
	place(item);
}

export function applyEdits(file: NbtFile, edits: Edit[]): void {
	const root = file.root;
	const dataVersion = num(child(root, 'DataVersion'));
	const format = formatOf(dataVersion);
	const equipment = usesEquipment(root, dataVersion);
	for (const edit of edits) {
		switch (edit.op) {
			case 'set': {
				const { tag, replace } = locate(root, edit.path);
				if (tag.type === 'list' || tag.type === 'compound') throw new PlayerDataError('Lists and compounds are edited entry by entry.');
				replace(parseValue(tag.type, edit.value));
				break;
			}
			case 'remove':
				locate(root, edit.path).remove();
				break;
			case 'add': {
				const parent = edit.path.length ? locate(root, edit.path).tag : root;
				const value = parseValue(edit.type, edit.value);
				if (parent.type === 'compound') {
					const name = (edit.name ?? '').trim();
					if (!name) throw new PlayerDataError('Give the new entry a name.');
					if (child(parent, name)) throw new PlayerDataError(`There already is an entry called "${name}".`);
					parent.value.push([name, value]);
				} else if (parent.type === 'list') {
					if (parent.value.length && parent.itemType !== edit.type) {
						throw new PlayerDataError(`This list holds ${parent.itemType} entries.`);
					}
					parent.itemType = edit.type;
					parent.value.push(value);
				} else {
					throw new PlayerDataError('Entries can only be added to lists and compounds.');
				}
				break;
			}
			case 'item':
			case 'removeItem':
				applyItem(root, edit, format, equipment);
				break;
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

/** Write `bytes` as the player's file: checked against `version`, previous file backed up, replaced atomically. */
async function replaceFile(instance: ServerInstance, uuid: string, version: string, bytes: Buffer, forceBackup: boolean): Promise<string> {
	const file = path.join(await playerDir(instance), `${uuid}.dat`);
	const current = await fs.readFile(file);
	if (versionOf(current) !== version) {
		throw new PlayerDataError('The file changed since you opened it (the player may have joined). Reload to see the current data.');
	}
	await backUp(instance, uuid, current, forceBackup);
	const tmp = `${file}.mineshell-tmp`;
	await fs.writeFile(tmp, bytes);
	await fs.rename(tmp, file);
	return versionOf(bytes);
}

/** Apply edits to the player's file. Returns the new version. */
export async function savePlayerData(instance: ServerInstance, uuid: string, version: string, edits: Edit[]): Promise<string> {
	const id = checkUuid(uuid);
	const { file, name } = await readPlayerData(instance, id);
	await requireOffline(instance, id, name);
	applyEdits(file, edits);
	return replaceFile(instance, id, version, writeNbt(file), false);
}

/** Put a backup back (the current file is backed up first). */
export async function restorePlayerBackup(instance: ServerInstance, uuid: string, version: string, backup: string): Promise<string> {
	const id = checkUuid(uuid);
	if (!/^\d+\.dat$/.test(backup)) throw new PlayerDataError('No such backup.');
	const bytes = await fs.readFile(path.join(backupDir(instance, id), backup)).catch(() => null);
	if (!bytes) throw new PlayerDataError('No such backup.');
	const { name } = await readPlayerData(instance, id);
	await requireOffline(instance, id, name);
	return replaceFile(instance, id, version, bytes, true);
}
