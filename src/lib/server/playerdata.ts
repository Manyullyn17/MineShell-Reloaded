import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerInstance } from './db/schema';
import { vanillaEnchantmentTable, type EnchantmentInfo } from './enchantnames';
import { child, num, parseNbt, removeChild, setChild, shortestFloat, writeNbt, type Compound, type NbtFile, type Tag } from './nbt';
import { applyTreeEdit, checkWritable, isPath, locate, parseTreeEdit, parseValue, toTree, type TreeEdit } from './nbtedit';
import { serverWorldName } from './packworld';
import { deleteToTrash } from './trash';
import { legacyItemIds, type ItemIds } from './itemids';
import {
	checkItem,
	idTag,
	describeItem,
	findContainers,
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
import type { Path, TreeTag } from '#lib/shared/nbt.js';

export type { Path, TreeTag };
import { audit, rconPassword } from './instances';
import { rconExec } from './rcon';
import { unitState } from './systemd';
import { cachedProfileNames, isOfflineUuid, lookUpProfileNames, lookUpProfiles } from './profiles';

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

export { PlayerDataError, shortestFloat, toTree };
export type { ContainerView, Format, ItemFields, ItemView, Section };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EQUIPMENT = 4325;

/** Inventory slot numbers for armor and offhand, as the pre-1.21.5 Inventory list has them. */
export const ARMOR_SLOTS = { 103: 'head', 102: 'chest', 101: 'legs', 100: 'feet' } as const;
export const OFFHAND_SLOT = -106;

// ------------------------------------------------------------------ files ---

/**
 * Where a world keeps one kind of player file: players/data, players/stats and
 * players/advancements from Minecraft 26, playerdata/, stats/ and advancements/
 * before. (Before 1.7.6 players/ held <name>.dat files, with no data/ in it.)
 */
export async function playerFolder(worldDir: string, kind: 'data' | 'stats' | 'advancements'): Promise<string> {
	const modern = await fs.access(path.join(worldDir, 'players', 'data')).then(
		() => true,
		() => false
	);
	return modern ? path.join(worldDir, 'players', kind) : path.join(worldDir, kind === 'data' ? 'playerdata' : kind);
}

async function playerDir(instance: ServerInstance): Promise<string> {
	return playerFolder(path.join(instance.path, await serverWorldName(instance.path)), 'data');
}

/** Where a player's file is, relative to the server folder (for Files' download), and when it was saved. */
export async function playerFileInfo(instance: ServerInstance, uuid: string): Promise<{ path: string; modifiedAt: number } | null> {
	const file = path.join(await playerDir(instance), `${checkUuid(uuid)}.dat`);
	const stat = await fs.stat(file).catch(() => null);
	return stat ? { path: path.relative(instance.path, file), modifiedAt: stat.mtimeMs } : null;
}

function checkUuid(uuid: string): string {
	if (!UUID.test(uuid)) throw new PlayerDataError('That is not a player id.');
	return uuid.toLowerCase();
}

const backupDir = (instance: ServerInstance, uuid: string) =>
	path.join(instance.path, '.mineshell', 'playerdata-backups', uuid);

/**
 * Names the server's own files give, by lower-case UUID: usercache.json, then
 * the whitelist, operator and ban lists (an imported world often comes
 * without the usercache, sometimes with the lists).
 */
async function knownNames(instance: ServerInstance): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	for (const file of ['usercache.json', 'whitelist.json', 'ops.json', 'banned-players.json']) {
		try {
			const entries = JSON.parse(await fs.readFile(path.join(instance.path, file), 'utf8')) as { uuid?: unknown; name?: unknown }[];
			for (const e of Array.isArray(entries) ? entries : []) {
				if (typeof e?.uuid !== 'string' || typeof e?.name !== 'string' || !e.name) continue;
				const uuid = e.uuid.toLowerCase();
				if (!names.has(uuid)) names.set(uuid, e.name);
			}
		} catch {
			/* missing or unreadable */
		}
	}
	return names;
}

/**
 * Faces for players known by name (the overview's "Online now"): the UUID the
 * server's files give each name, and its skin from Mojang (cached). A name with
 * no UUID is coloured by name, as the game does for a name-only waypoint.
 */
export async function facesByName(instance: ServerInstance, names: string[]): Promise<Record<string, { id: string; skin: string | null }>> {
	const byName = new Map([...(await knownNames(instance))].map(([uuid, name]) => [name.toLowerCase(), uuid]));
	const uuids = names.map((n) => byName.get(n.toLowerCase())).filter((u): u is string => !!u);
	const profiles = await lookUpProfiles(uuids);
	return Object.fromEntries(
		names.map((name) => {
			const uuid = byName.get(name.toLowerCase());
			return [name, { id: uuid ?? name, skin: uuid ? (profiles.get(uuid)?.skin ?? null) : null }];
		})
	);
}

export type PlayerFile = {
	uuid: string;
	name: string | null;
	/** Where the name is from: the server's own files, or Mojang (the account's current name). */
	nameFrom: 'server' | 'mojang' | null;
	/** An offline-mode UUID: made from the name, which nothing can look up. */
	offline: boolean;
	modifiedAt: number;
	size: number;
};

/** The world's player files, named from the server's files and earlier Mojang lookups (lookUpProfileNames asks for the rest). */
export async function listPlayerData(instance: ServerInstance): Promise<PlayerFile[]> {
	const dir = await playerDir(instance);
	const names = await knownNames(instance);
	const found: PlayerFile[] = [];
	for (const entry of await fs.readdir(dir).catch(() => [] as string[])) {
		const uuid = entry.replace(/\.dat$/, '').toLowerCase();
		if (!entry.endsWith('.dat') || !UUID.test(uuid)) continue;
		const stat = await fs.stat(path.join(dir, entry)).catch(() => null);
		if (!stat?.isFile()) continue;
		const name = names.get(uuid) ?? null;
		found.push({ uuid, name, nameFrom: name ? 'server' : null, offline: isOfflineUuid(uuid), modifiedAt: stat.mtimeMs, size: stat.size });
	}
	const looked = await cachedProfileNames(found.filter((f) => !f.name).map((f) => f.uuid));
	for (const f of found) {
		if (f.name || !looked.has(f.uuid)) continue;
		f.name = looked.get(f.uuid)!;
		f.nameFrom = 'mojang';
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
		const name = (await knownNames(instance)).get(id) ?? (await lookUpProfileNames([id])).get(id) ?? null;
		return { file: parseNbt(bytes), version: versionOf(bytes), name };
	} catch (err) {
		throw new PlayerDataError(`The player file could not be read: ${err instanceof Error ? err.message : 'unknown error'}`);
	}
}

// ------------------------------------------------------------------- view ---

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
	/**
	 * 1.12-or-older enchantment numbers, for the item editor: vanilla's here, the
	 * world's own table (enchantnames.ts) once the route has read level.dat. Empty for newer files.
	 */
	legacyEnchantments: Record<number, EnchantmentInfo>;
	tree: TreeTag;
};

function usesEquipment(root: Compound, dataVersion: number | null): boolean {
	return child(root, 'equipment')?.type === 'compound' || (dataVersion ?? 0) >= EQUIPMENT;
}

function sectionOf(slot: number): Section {
	if (slot >= 0 && slot <= 35) return 'main';
	if (slot in ARMOR_SLOTS) return 'armor';
	return slot === OFFHAND_SLOT ? 'offhand' : 'other';
}

/** `ids`: before 1.8, the world's item numbers (itemids.ts): items show by name. */
export function playerView(file: NbtFile, ids: ItemIds | null = null): PlayerView {
	const root = file.root;
	const dataVersion = num(child(root, 'DataVersion'));
	const style = { ...styleOf(dataVersion), ...(ids ? { ids } : {}) };
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
		legacyEnchantments: style.format === 'legacy' ? vanillaEnchantmentTable() : {},
		tree: toTree(root)
	};
}

// ------------------------------------------------------------------ edits ---

export type Edit =
	| TreeEdit
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

/** Edits as the browser sent them, checked for shape (values are checked when applied). */
export function parseEdits(raw: unknown): Edit[] {
	if (!Array.isArray(raw)) throw new PlayerDataError('That change could not be read.');
	return raw.map((e): Edit => {
		const bad = () => new PlayerDataError('That change could not be read.');
		if (!e || typeof e !== 'object') throw bad();
		const tree = parseTreeEdit(e, bad);
		if (tree) return tree;
		switch (e.op) {
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

/** Where an item for (section, slot) lives: a list and the slot number in it, or an equipment key. */
function itemHome(section: Section, slot: number, equipment: boolean) {
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
	const home = itemHome(edit.section, edit.slot, equipment);
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

	const id = checkItem(edit.id, edit.count, style);

	// Changing an item keeps everything else on it (enchantments, names, NBT).
	const item: Compound = existing ?? { type: 'compound', value: [] };
	if (!existing && !('equipment' in home && home.equipment)) setChild(item, 'Slot', { type: 'byte', value: edit.slot });
	setChild(item, 'id', idTag(id, style));
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

/**
 * Edits apply in order, each path meaning the file as the edits before it
 * left it: removing entry 0 of a list twice removes its first two entries.
 * The page sends removals one at a time, so positions never shift under a
 * batch it sends.
 */
export function applyEdits(file: NbtFile, edits: Edit[], ids: ItemIds | null = null): void {
	const root = file.root;
	const dataVersion = num(child(root, 'DataVersion'));
	const style = { ...styleOf(dataVersion), ...(ids ? { ids } : {}) };
	const equipment = usesEquipment(root, dataVersion);
	for (const edit of edits) {
		switch (edit.op) {
			case 'set':
			case 'replace':
			case 'rename':
			case 'remove':
			case 'add':
				applyTreeEdit(root, edit);
				break;
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
	checkWritable(file);
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
	// Named by the time, and never over another: a save's backup and a restore's forced one can
	// fall in the same millisecond, and the second used to replace the first.
	for (let at = Math.max(Date.now(), (existing[0]?.at ?? 0) + 1); ; at++) {
		const written = await fs.writeFile(path.join(dir, `${at}.dat`), bytes, { flag: 'wx' }).then(
			() => true,
			(err: NodeJS.ErrnoException) => {
				if (err.code === 'EEXIST') return false;
				throw err;
			}
		);
		if (written) break;
	}
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
	applyEdits(file, edits, await legacyItemIds(instance));
	return replaceFile(instance, id, name, version, writeNbt(file), false);
}

/**
 * Removes what the world keeps about a player: their player file (and the
 * game's .dat_old), stats and advancements, and MineShell's backups of the
 * file. Into the trash (Files), so it can be put back. The player drops out of
 * the player list unless a list (whitelist, ops, bans) still names them, and
 * starts over if they join again. Never while they are online: the server
 * writes everything back when they leave. Returns the paths moved, relative
 * to the server folder.
 */
export async function removePlayerFiles(instance: ServerInstance, uuid: string): Promise<string[]> {
	const id = checkUuid(uuid);
	const online = await onlinePlayerIds(instance);
	if (online === null) {
		throw new PlayerDataError('The server is running and MineShell cannot tell who is online (RCON is not answering). Stop the server to remove a player.');
	}
	if (online.has(id)) throw new PlayerDataError('That player is online, and the server would write their files back when they leave. Kick them first.');
	const world = path.join(instance.path, await serverWorldName(instance.path));
	const data = await playerFolder(world, 'data');
	const candidates = [
		path.join(data, `${id}.dat`),
		path.join(data, `${id}.dat_old`),
		path.join(await playerFolder(world, 'stats'), `${id}.json`),
		path.join(await playerFolder(world, 'advancements'), `${id}.json`),
		backupDir(instance, id)
	].map((file) => path.relative(instance.path, file));
	const removed: string[] = [];
	for (const rel of candidates) {
		if (!(await fs.lstat(path.join(instance.path, rel)).catch(() => null))) continue;
		await deleteToTrash(instance.path, rel);
		removed.push(rel.split(path.sep).join('/'));
	}
	if (!removed.length) throw new PlayerDataError('This world has no files for that player.');
	audit('player.removed', { instanceId: instance.id, detail: id });
	return removed;
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
