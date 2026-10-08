import { child, num, removeChild, setChild, str, type Compound, type Tag } from './nbt';
import type { Path } from '#lib/shared/nbt.js';

/**
 * Items inside NBT: what they show (fields like name, lore, enchantments),
 * and the containers they hold (shulker boxes, bundles, mod backpacks).
 *
 * Where each field lives depends on the item format:
 * - legacy (before 1.13): `tag.display.Name` plain text, `tag.ench` with
 *   numeric ids, `Damage` is the metadata
 * - flat (1.13 to 1.20.4): `tag.display.Name`/`Lore` as JSON text,
 *   `tag.Enchantments` with string ids, `tag.Damage` the durability
 * - components (1.20.5+): `components["minecraft:custom_name"]` etc.; up to
 *   1.21.4 text is JSON and enchantments sit under `levels`, from 1.21.5
 *   text is an NBT text component and enchantments are a plain map.
 */

export class PlayerDataError extends Error {}

export const FLATTENING = 1519;
export const COMPONENTS = 3837;
/** 1.21.5: text as NBT, enchantments without `levels`, armor in `equipment`. */
export const NBT_TEXT = 4325;

export type Format = 'legacy' | 'flat' | 'components';
export type Style = { format: Format; nbtText: boolean };

export function styleOf(dataVersion: number | null): Style {
	const format: Format =
		dataVersion === null || dataVersion < FLATTENING ? 'legacy' : dataVersion < COMPONENTS ? 'flat' : 'components';
	return { format, nbtText: (dataVersion ?? 0) >= NBT_TEXT };
}

export type Section = 'main' | 'armor' | 'offhand' | 'ender' | 'other' | 'container';

export type Enchantment = { id: string; level: number };

export type ItemFields = {
	name: string | null;
	lore: string[];
	enchantments: Enchantment[];
	/** An enchanted book: its enchantments are stored, not applied. */
	stored: boolean;
	unbreakable: boolean;
	/** Durability used (1.13+); before 1.13 that is the item's Damage. */
	damage: number | null;
};

export type ContainerView = {
	/** The list holding the items. */
	path: Path;
	label: string;
	/**
	 * Lists inside the entries of one list (Curios: one entry per slot type,
	 * each with Stacks and Cosmetics) belong together; `label` is then the
	 * part after the group's.
	 */
	group: { id: string; label: string } | null;
	/** Slots to show; null for a container without slots (a bundle: just a sequence). */
	size: number | null;
	items: ItemView[];
};

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
	fields: ItemFields;
	containers: ContainerView[];
};

// ------------------------------------------------------------------- text ---

/** Plain text of a text component: JSON (1.13+), NBT (1.21.5+) or plain (1.12). */
export function textOf(tag: Tag | undefined): string | null {
	if (!tag) return null;
	if (tag.type === 'compound') {
		const extra = child(tag, 'extra');
		return (str(child(tag, 'text')) ?? '') + (extra?.type === 'list' ? extra.value.map((e) => textOf(e) ?? '').join('') : '');
	}
	if (tag.type !== 'string') return null;
	try {
		const parsed = JSON.parse(tag.value);
		if (typeof parsed === 'string') return parsed;
		if (parsed && typeof parsed === 'object') return jsonText(parsed);
	} catch {
		/* plain text */
	}
	return tag.value;
}

function jsonText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(jsonText).join('');
	if (value && typeof value === 'object') {
		const v = value as { text?: unknown; extra?: unknown[] };
		return (typeof v.text === 'string' ? v.text : '') + (Array.isArray(v.extra) ? v.extra.map(jsonText).join('') : '');
	}
	return '';
}

/** Text written the way the format stores it. */
function textTag(text: string, style: Style): Tag {
	if (style.format === 'legacy' || style.nbtText) return { type: 'string', value: text };
	return { type: 'string', value: JSON.stringify({ text, italic: false }) };
}

// ----------------------------------------------------------------- fields ---

/** 1.12's numeric enchantment ids. */
export const LEGACY_ENCHANTMENTS: Record<number, string> = {
	0: 'protection', 1: 'fire_protection', 2: 'feather_falling', 3: 'blast_protection', 4: 'projectile_protection',
	5: 'respiration', 6: 'aqua_affinity', 7: 'thorns', 8: 'depth_strider', 9: 'frost_walker', 10: 'binding_curse',
	16: 'sharpness', 17: 'smite', 18: 'bane_of_arthropods', 19: 'knockback', 20: 'fire_aspect', 21: 'looting',
	22: 'sweeping', 32: 'efficiency', 33: 'silk_touch', 34: 'unbreaking', 35: 'fortune', 48: 'power', 49: 'punch',
	50: 'flame', 51: 'infinity', 61: 'luck_of_the_sea', 62: 'lure', 70: 'mending', 71: 'vanishing_curse'
};

const dataKey = (style: Style) => (style.format === 'components' ? 'components' : 'tag');
const isBook = (item: Compound) => /enchanted_book$/.test(str(child(item, 'id')) ?? '');

function enchantKey(style: Style, stored: boolean): string {
	if (style.format === 'components') return stored ? 'minecraft:stored_enchantments' : 'minecraft:enchantments';
	if (style.format === 'flat') return stored ? 'StoredEnchantments' : 'Enchantments';
	return stored ? 'StoredEnchantments' : 'ench';
}

export function readFields(item: Compound, style: Style): ItemFields {
	const data = child(item, dataKey(style));
	const stored = isBook(item);
	const component = (key: string) => child(data, key);
	const display = child(data, 'display');

	const loreTag = style.format === 'components' ? component('minecraft:lore') : child(display, 'Lore');
	const enchantTag = component(enchantKey(style, stored));
	let enchantments: Enchantment[] = [];
	if (enchantTag?.type === 'list') {
		enchantments = enchantTag.value.map((e) => {
			const id = child(e, 'id');
			return { id: id?.type === 'string' ? id.value : String(num(id) ?? ''), level: num(child(e, 'lvl')) ?? 1 };
		});
	} else if (enchantTag?.type === 'compound') {
		const levels = child(enchantTag, 'levels');
		const map = levels?.type === 'compound' ? levels : enchantTag;
		enchantments = map.value.filter(([, v]) => v.type !== 'compound' && num(v) !== null).map(([id, v]) => ({ id, level: num(v)! }));
	}

	return {
		name: textOf(style.format === 'components' ? component('minecraft:custom_name') : child(display, 'Name')),
		lore: loreTag?.type === 'list' ? loreTag.value.map((l) => textOf(l) ?? '') : [],
		enchantments,
		stored,
		unbreakable: style.format === 'components' ? !!component('minecraft:unbreakable') : num(component('Unbreakable')) === 1,
		damage: style.format === 'legacy' ? null : num(component(style.format === 'components' ? 'minecraft:damage' : 'Damage'))
	};
}

const ENCHANT_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

/** Write the given fields onto the item, in its format; an emptied field is removed. */
export function writeFields(item: Compound, fields: Partial<Omit<ItemFields, 'stored'>>, style: Style): void {
	const key = dataKey(style);
	const existing = child(item, key);
	const data: Compound = existing?.type === 'compound' ? existing : { type: 'compound', value: [] };
	const components = style.format === 'components';
	const display = (): Compound => {
		let d = child(data, 'display');
		if (d?.type !== 'compound') {
			d = { type: 'compound', value: [] };
			setChild(data, 'display', d);
		}
		return d;
	};

	if (fields.name !== undefined) {
		const name = fields.name?.trim() ? textTag(fields.name, style) : null;
		if (components) name ? setChild(data, 'minecraft:custom_name', name) : removeChild(data, 'minecraft:custom_name');
		else name ? setChild(display(), 'Name', name) : removeChild(display(), 'Name');
	}
	if (fields.lore !== undefined) {
		const lines = fields.lore.map((l) => textTag(l, style));
		const lore: Tag | null = lines.length ? { type: 'list', itemType: 'string', value: lines } : null;
		if (components) lore ? setChild(data, 'minecraft:lore', lore) : removeChild(data, 'minecraft:lore');
		else lore ? setChild(display(), 'Lore', lore) : removeChild(display(), 'Lore');
	}
	if (fields.enchantments !== undefined) writeEnchantments(data, fields.enchantments, style, isBook(item));
	if (fields.unbreakable !== undefined) {
		if (components) fields.unbreakable ? setChild(data, 'minecraft:unbreakable', { type: 'compound', value: [] }) : removeChild(data, 'minecraft:unbreakable');
		else fields.unbreakable ? setChild(data, 'Unbreakable', { type: 'byte', value: 1 }) : removeChild(data, 'Unbreakable');
	}
	if (fields.damage !== undefined && style.format !== 'legacy') {
		const damage = fields.damage ?? 0;
		if (!Number.isInteger(damage) || damage < 0 || damage > 2147483647) throw new PlayerDataError('Durability used must be a whole number of 0 or more.');
		const name = components ? 'minecraft:damage' : 'Damage';
		if (damage === 0 && components) removeChild(data, name);
		else setChild(data, name, { type: 'int', value: damage });
	}

	// Nothing left in display, or in the data at all: leave no empty husks.
	const d = child(data, 'display');
	if (d?.type === 'compound' && d.value.length === 0) removeChild(data, 'display');
	if (data.value.length) setChild(item, key, data);
	else removeChild(item, key);
}

function writeEnchantments(data: Compound, list: Enchantment[], style: Style, stored: boolean): void {
	const key = enchantKey(style, stored);
	for (const e of list) {
		if (!Number.isInteger(e.level) || e.level < 1 || e.level > 255) throw new PlayerDataError('Enchantment levels go from 1 to 255.');
		if (style.format === 'legacy' ? !/^\d+$/.test(e.id) : !ENCHANT_ID.test(e.id)) {
			throw new PlayerDataError(
				style.format === 'legacy' ? `"${e.id}" is not a 1.12 enchantment number.` : `"${e.id}" is not an enchantment id (like minecraft:sharpness).`
			);
		}
	}
	if (list.length === 0) {
		removeChild(data, key);
		return;
	}
	if (style.format !== 'components') {
		const legacy = style.format === 'legacy';
		setChild(data, key, {
			type: 'list',
			itemType: 'compound',
			value: list.map((e) => ({
				type: 'compound',
				value: [
					['id', legacy ? { type: 'short', value: Number(e.id) } : { type: 'string', value: e.id }],
					['lvl', { type: 'short', value: e.level }]
				]
			}))
		});
		return;
	}
	const levels: Compound = { type: 'compound', value: list.map((e) => [e.id, { type: 'int', value: e.level }]) };
	if (style.nbtText) {
		setChild(data, key, levels);
		return;
	}
	// Up to 1.21.4 the levels sit under `levels`, next to show_in_tooltip, which stays.
	const existing = child(data, key);
	const component: Compound = existing?.type === 'compound' ? existing : { type: 'compound', value: [] };
	setChild(component, 'levels', levels);
	setChild(data, key, component);
}

// ------------------------------------------------------------- containers ---

/** How a list stores its items. */
export type Shape = {
	/** `{slot, item: {...}}` (1.20.5+ containers) rather than the item with its slot inline. */
	wrapped: boolean;
	slotKey: 'Slot' | 'slot' | null;
	slotType: 'byte' | 'int';
	countKey: 'Count' | 'count';
	countType: 'byte' | 'int';
};

const SIZES: [RegExp, number][] = [
	[/shulker_box$|chest$|barrel$/, 27],
	[/dispenser$|dropper$|crafter$/, 9],
	[/hopper$/, 5],
	[/furnace$|smoker$/, 3]
];

/** Keys an item compound has; enchantment ({id, lvl}) or attribute ({id, base}) entries have others. */
const ITEM_KEYS = new Set(['id', 'Count', 'count', 'Slot', 'slot', 'Damage', 'tag', 'components', 'ForgeCaps']);

function itemLike(tag: Tag): boolean {
	if (tag.type !== 'compound') return false;
	const inner = child(tag, 'item');
	const item = inner?.type === 'compound' ? inner : tag;
	if (child(item, 'id')?.type !== 'string') return false;
	// A count says item; without one (1.20.5+ leaves out a count of 1), only item keys may be there.
	return num(child(item, 'Count') ?? child(item, 'count')) !== null || item.value.every(([k]) => ITEM_KEYS.has(k));
}

/** `Slot12` or `12`: a compound keyed by slot (Thermal's satchel: `Inventory: {Slot50: {...}}`). */
const SLOT_KEY = /^(slot)?_?(\d+)$/i;

function keyedItems(tag: Tag): tag is Compound {
	return tag.type === 'compound' && tag.value.length > 0 && tag.value.every(([k, v]) => SLOT_KEY.test(k) && itemLike(v));
}

/** The entries' own shape, or (empty list) what that kind of list uses. */
export function shapeOf(list: Extract<Tag, { type: 'list' }>, at: Path, style: Style, parent?: Tag): Shape {
	const first = list.value[0];
	if (first?.type === 'compound') {
		const wrapped = child(first, 'item')?.type === 'compound';
		const item = (wrapped ? child(first, 'item') : first) as Compound;
		const slotKey = child(first, 'Slot') ? 'Slot' : child(first, 'slot') ? 'slot' : null;
		const slotTag = slotKey ? child(first, slotKey) : undefined;
		const countKey = child(item, 'count') ? 'count' : child(item, 'Count') ? 'Count' : style.format === 'components' ? 'count' : 'Count';
		const countTag = child(item, countKey);
		return {
			wrapped,
			slotKey,
			slotType: slotTag?.type === 'int' ? 'int' : 'byte',
			countKey,
			countType: countTag?.type === 'int' || (!countTag && countKey === 'count') ? 'int' : 'byte'
		};
	}
	const last = at[at.length - 1];
	const modern = style.format === 'components';
	if (last === 'minecraft:container') return { wrapped: true, slotKey: 'slot', slotType: 'int', countKey: 'count', countType: 'int' };
	if (last === 'minecraft:bundle_contents') return { wrapped: false, slotKey: null, slotType: 'int', countKey: 'count', countType: 'int' };
	return {
		wrapped: false,
		slotKey: 'Slot',
		// A mod's item handler ({Items, Size}) numbers slots with ints.
		slotType: last === 'Items' && child(parent, 'Size') ? 'int' : 'byte',
		countKey: modern ? 'count' : 'Count',
		countType: modern ? 'int' : 'byte'
	};
}

function containerSize(itemId: string, slots: number[], sizeTag: Tag | undefined): number {
	const declared = num(sizeTag);
	if (declared !== null && declared > 0 && declared <= 1024) return declared;
	const known = SIZES.find(([re]) => re.test(itemId))?.[1];
	const needed = slots.length ? Math.max(...slots) + 1 : 0;
	return Math.max(known ?? 0, Math.ceil(Math.max(needed, 9) / 9) * 9);
}

/**
 * Item lists under `tag`: the known ones (shulker/chest contents, bundles,
 * the 1.20.5+ container component) and any other list whose entries all
 * look like items - mod backpacks, Curios/Trinkets slots.
 */
export function findContainers(tag: Compound, at: Path, style: Style, itemId: string, depth: number, skip: Set<string> = new Set()): ContainerView[] {
	const found: ContainerView[] = [];
	/** Where a container is, in words: keys, and list entries by their own name when they have one. */
	type Place = { names: string[]; group: { id: string; label: string; from: number } | null };
	const walk = (node: Tag, path: Path, place: Place, level: number) => {
		if (level > 8) return;
		if (node.type === 'compound') {
			for (const [key, value] of node.value) {
				if (level === 0 && skip.has(key)) continue;
				const p = [...path, key];
				const here = { ...place, names: [...place.names, key] };
				if (value.type === 'list' && isItemList(value, node, key)) {
					found.push(container(value, node, p, key, here, level));
				} else if (keyedItems(value)) {
					found.push(keyedContainer(value, node, p, key, here, level));
				} else if (!itemLike(value)) {
					// An item's own contents belong to that item, shown when it is opened.
					walk(value, p, here, level + 1);
				}
			}
		} else if (node.type === 'list' && node.itemType === 'compound') {
			// Lists of compounds that are not item lists can still hold some (a list of pages, each with Items).
			// Named by the list's own key ("Curios"), not the whole way there.
			const group = place.group ?? { id: JSON.stringify(path), label: labelOf(place.names).split(' › ').pop() || 'Items', from: place.names.length };
			node.value.forEach((v, i) => {
				if (itemLike(v)) return;
				const name = entryName(v);
				walk(v, [...path, i], { names: name ? [...place.names, name] : place.names, group }, level + 1);
			});
		}
	};
	const placed = (key: string, place: Place, level: number) => {
		const { group } = place;
		if (!group) return { label: containerLabel(key, place.names, level), group: null };
		return { label: labelOf(place.names.slice(group.from)) || group.label, group: { id: group.id, label: group.label } };
	};
	const isItemList = (list: Extract<Tag, { type: 'list' }>, parent: Compound, key: string) =>
		list.value.length > 0
			? list.itemType === 'compound' && list.value.every(itemLike)
			: key === 'minecraft:container' || key === 'minecraft:bundle_contents' || (key === 'Items' && !!child(parent, 'Size'));
	const container = (list: Extract<Tag, { type: 'list' }>, parent: Compound, path: Path, key: string, place: Place, level: number): ContainerView => {
		const shape = shapeOf(list, path, style, parent);
		const items: ItemView[] = [];
		list.value.forEach((entry, i) => {
			const slot = shape.slotKey ? num(child(entry, shape.slotKey)) : i;
			const itemPath = shape.wrapped ? [...path, i, 'item'] : [...path, i];
			const item = shape.wrapped ? child(entry, 'item') : entry;
			const view = slot === null || !item ? null : describeItem(item, 'container', slot, itemPath, style, depth + 1);
			if (view) items.push(view);
		});
		return {
			path,
			...placed(key, place, level),
			size: shape.slotKey ? containerSize(itemId, items.map((i) => i.slot), child(parent, 'Size')) : null,
			items
		};
	};
	const keyedContainer = (items: Compound, parent: Compound, path: Path, key: string, place: Place, level: number): ContainerView => {
		const views = items.value
			.map(([k, v]) => describeItem(v, 'container', Number(k.match(SLOT_KEY)![2]), [...path, k], style, depth + 1))
			.filter((v): v is ItemView => !!v);
		return {
			path,
			...placed(key, place, level),
			size: containerSize(itemId, views.map((v) => v.slot), child(parent, 'Size') ?? child(items, 'Size')),
			items: views
		};
	};
	walk(tag, at, { names: [], group: null }, 0);
	return found;
}

/** A list entry's own name: Curios' `Identifier: "ring"`, or an id or name. */
function entryName(entry: Tag): string | null {
	for (const key of ['Identifier', 'identifier', 'id', 'Id', 'name', 'Name', 'key']) {
		const tag = child(entry, key);
		if (tag?.type === 'string' && tag.value) return tag.value;
	}
	return null;
}

/**
 * Wrappers that say where mods keep data, not what it is: Forge's capabilities,
 * NeoForge's attachments, an item's tag/components, Curios' handler.
 */
const WRAPPERS = new Set(['tag', 'components', 'ForgeCaps', 'neoforge:attachments', 'StacksHandler']);

function labelOf(names: string[]): string {
	const parts = names.filter((p) => !WRAPPERS.has(p));
	// "... › necklace › Items" (Curios: "ring › Stacks › Items"): the last parts say nothing.
	while (parts.length > 1 && (parts.at(-1) === 'Items' || parts.at(-1) === 'Stacks')) parts.pop();
	return parts.join(' › ');
}

function containerLabel(key: string, names: string[], level: number): string {
	if (key === 'minecraft:container' || (key === 'Items' && names.includes('BlockEntityTag'))) return 'Contents';
	if (key === 'minecraft:bundle_contents' || (key === 'Items' && level === 0)) return 'Contents';
	return labelOf(names);
}

export function describeItem(item: Tag, section: Section, slot: number, at: Path, style: Style, depth = 0): ItemView | null {
	if (item.type !== 'compound') return null;
	const idTag = child(item, 'id');
	const id = idTag?.type === 'string' ? idTag.value : idTag ? String(num(idTag)) : '';
	const data = child(item, dataKey(style)) ?? child(item, 'tag') ?? child(item, 'components');
	const fields = readFields(item, style);
	return {
		section,
		slot,
		id,
		count: num(child(item, 'count')) ?? num(child(item, 'Count')) ?? 1,
		damage: style.format === 'legacy' ? num(child(item, 'Damage')) : null,
		name: fields.name,
		hasData: data?.type === 'compound' ? data.value.length > 0 : !!data,
		path: at,
		fields,
		// Containers in containers in containers: enough is enough.
		containers: data?.type === 'compound' && depth < 4 ? findContainers(data, [...at, data === child(item, 'tag') ? 'tag' : 'components'], style, id, depth) : []
	};
}

// --------------------------------------------------------- container edits ---

const COUNT_MAX = { byte: 127, short: 32767, int: 2147483647 } as const;

/**
 * 1.12's Damage (metadata): written when given, or as 0 on a new item; an
 * existing item without one is left without one, so an edit changes only
 * what was asked.
 */
export function setDamage(item: Compound, damage: number | null | undefined, isNew: boolean, style: Style): void {
	if (style.format !== 'legacy' || (damage == null && !isNew)) return;
	const value = damage ?? 0;
	if (!Number.isInteger(value) || value < -32768 || value > 32767) throw new PlayerDataError('Damage must be a whole number from -32768 to 32767.');
	setChild(item, 'Damage', { type: 'short', value });
}

/** How the counts next to this item are stored, for a new item to match (stack-size mods use an int Count). */
export function countStyle(neighbours: Tag[]): { key: 'Count' | 'count'; type: 'byte' | 'short' | 'int' } | null {
	for (const n of neighbours) {
		const item = child(n, 'item')?.type === 'compound' ? child(n, 'item') : n;
		const tag = child(item, 'Count') ?? child(item, 'count');
		if (tag && (tag.type === 'byte' || tag.type === 'short' || tag.type === 'int')) return { key: child(item, 'Count') ? 'Count' : 'count', type: tag.type };
	}
	return null;
}

/**
 * Set the count, keeping the type of one already there. The limit is what
 * that type holds - so an int Count (a stack-size mod) takes more than 127 -
 * except that 1.20.5+ items stop at 99 like the game, unless this item
 * already holds more.
 */
export function setCount(item: Compound, key: 'Count' | 'count', type: 'byte' | 'short' | 'int', count: number, style: Style): void {
	const existing = child(item, 'Count') ?? child(item, 'count');
	const name = existing ? (child(item, 'Count') ? 'Count' : 'count') : key;
	const kind = existing && (existing.type === 'byte' || existing.type === 'short' || existing.type === 'int') ? existing.type : type;
	const max = style.format === 'components' && (num(existing) ?? 0) <= 99 ? 99 : COUNT_MAX[kind];
	if (count > max) throw new PlayerDataError(`The count must be between 1 and ${max}.`);
	setChild(item, name, { type: kind, value: count });
}

/** An item into a slot-keyed compound (`{Slot50: {...}}`), copying the keys and count style already there. */
export function setKeyedItem(items: Compound, slot: number, item: { id: string; count: number; damage?: number | null } | null, style: Style): void {
	if (!Number.isInteger(slot) || slot < 0) throw new PlayerDataError('No such slot.');
	const found = items.value.find(([k]) => Number(k.match(SLOT_KEY)?.[2]) === slot);
	if (!item) {
		if (!found) throw new PlayerDataError('That slot is already empty.');
		removeChild(items, found[0]);
		return;
	}
	const id = checkItem(item.id, item.count);
	const sample = items.value[0]?.[1] as Compound | undefined;
	const prefix = items.value[0]?.[0].match(/^(\D*)\d+$/)?.[1] ?? 'Slot';
	const target: Compound = found && found[1].type === 'compound' ? found[1] : { type: 'compound', value: [] };
	setChild(target, 'id', { type: 'string', value: id });
	const sampleCount = sample ? (child(sample, 'Count') ?? child(sample, 'count')) : undefined;
	setCount(
		target,
		sample && child(sample, 'count') ? 'count' : style.format === 'components' ? 'count' : 'Count',
		sampleCount?.type === 'int' || (!sampleCount && style.format === 'components') ? 'int' : 'byte',
		item.count,
		style
	);
	setDamage(target, item.damage, !found, style);
	if (!found) items.value.push([`${prefix}${slot}`, target]);
}

const ITEM_ID = /^[a-z0-9_.-]+:[a-zA-Z0-9_./-]+$/;

/** The id, checked; the count's upper limit depends on how it is stored and is checked by setCount. */
export function checkItem(id: string, count: number): string {
	const clean = id.trim();
	if (!ITEM_ID.test(clean)) throw new PlayerDataError(`"${id}" is not an item id (like minecraft:diamond).`);
	if (!Number.isInteger(count) || count < 1) throw new PlayerDataError('The count must be a whole number of 1 or more.');
	return clean;
}

/** Put an item into a container's slot (replacing id and count of one already there, keeping its data), or take it out. */
export function setContainerItem(
	list: Extract<Tag, { type: 'list' }>,
	parent: Tag,
	at: Path,
	slot: number,
	item: { id: string; count: number; damage?: number | null } | null,
	style: Style
): void {
	const shape = shapeOf(list, at, style, parent);
	const size = shape.slotKey ? num(child(parent, 'Size')) : null;
	if (!Number.isInteger(slot) || slot < 0 || (size !== null && slot >= size)) {
		throw new PlayerDataError(size !== null ? `This container has slots 0 to ${size - 1}.` : 'No such slot.');
	}
	const index = shape.slotKey ? list.value.findIndex((e) => num(child(e, shape.slotKey!)) === slot) : slot < list.value.length ? slot : -1;
	if (!item) {
		if (index < 0) throw new PlayerDataError('That slot is already empty.');
		list.value.splice(index, 1);
		return;
	}
	const id = checkItem(item.id, item.count);
	const entry: Compound = index >= 0 ? (list.value[index] as Compound) : { type: 'compound', value: [] };
	if (index < 0 && shape.slotKey) setChild(entry, shape.slotKey, { type: shape.slotType, value: slot });
	let target = entry;
	if (shape.wrapped) {
		const inner = child(entry, 'item');
		target = inner?.type === 'compound' ? inner : { type: 'compound', value: [] };
		setChild(entry, 'item', target);
	}
	setChild(target, 'id', { type: 'string', value: id });
	setCount(target, shape.countKey, shape.countType, item.count, style);
	setDamage(target, item.damage, index < 0, style);
	if (index < 0) {
		list.itemType = 'compound';
		list.value.push(entry);
	}
}
