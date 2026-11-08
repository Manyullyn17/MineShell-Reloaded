import { child, NbtError, parseNbt, removeChild, setChild, shortestFloat, writeNbt, type Compound, type NbtFile, type Tag, type TagType } from './nbt';
import { parseSnbt, SnbtError } from './snbt';
import type { Path, TreeTag } from '#lib/shared/nbt.js';

/**
 * Changes to an NBT tree by path, as the tree on a page sends them (NbtNode.svelte): set a
 * value, rename, remove, add, replace with SNBT. Shared by the player editor (playerdata.ts,
 * which adds its own item and effect edits) and the NBT editor in Files (nbtfiles.ts). The
 * browser never sends a whole tree, so what it does not show survives.
 */

/** Why a change was refused; the player editor knows it as PlayerDataError. */
export class NbtEditError extends Error {}

export type TreeEdit =
	/** A new value; with `type`, also a new type (a value in a compound only). */
	| { op: 'set'; path: Path; value: string; type?: TagType }
	| { op: 'remove'; path: Path }
	/** `type: 'snbt'` takes a whole structure as text. */
	| { op: 'add'; path: Path; name?: string; type: TagType | 'snbt'; value?: string }
	/** Replace any entry, compounds and lists included, with SNBT. */
	| { op: 'replace'; path: Path; snbt: string }
	| { op: 'rename'; path: Path; name: string };

export const isPath = (p: unknown): p is Path =>
	Array.isArray(p) && p.every((k) => typeof k === 'string' || (typeof k === 'number' && Number.isInteger(k)));

export const TAG_TYPES = new Set<TagType>(['byte', 'short', 'int', 'long', 'float', 'double', 'string', 'byteArray', 'intArray', 'longArray', 'list', 'compound']);

/** One of the tree's edits as the browser sent it, checked for shape; null for any other op. */
export function parseTreeEdit(e: Record<string, unknown>, bad: () => Error): TreeEdit | null {
	switch (e.op) {
		case 'set':
			if (!isPath(e.path) || typeof e.value !== 'string' || (e.type !== undefined && !TAG_TYPES.has(e.type as TagType))) throw bad();
			return { op: 'set', path: e.path, value: e.value, ...(e.type ? { type: e.type as TagType } : {}) };
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
			if (!isPath(e.path) || !(TAG_TYPES.has(e.type as TagType) || e.type === 'snbt')) throw bad();
			return { op: 'add', path: e.path, type: e.type as TagType | 'snbt', name: String(e.name ?? ''), value: String(e.value ?? '') };
		default:
			return null;
	}
}

const RANGES: Partial<Record<TagType, [number, number]>> = {
	byte: [-128, 127],
	short: [-32768, 32767],
	int: [-2147483648, 2147483647]
};

function integer(raw: string, type: TagType): number {
	const text = raw.trim();
	const [min, max] = RANGES[type]!;
	if (!/^-?\d+$/.test(text) || Number(text) < min || Number(text) > max) {
		throw new NbtEditError(`"${raw}" is not a whole number between ${min} and ${max}.`);
	}
	return Number(text);
}

function bigint(raw: string): bigint {
	const text = raw.trim();
	if (!/^-?\d+$/.test(text)) throw new NbtEditError(`"${raw}" is not a whole number.`);
	const value = BigInt(text);
	if (value < -(2n ** 63n) || value >= 2n ** 63n) throw new NbtEditError(`"${raw}" is out of range for a long.`);
	return value;
}

function decimal(raw: string): number {
	const value = Number(raw.trim());
	if (raw.trim() === '' || !Number.isFinite(value)) throw new NbtEditError(`"${raw}" is not a number.`);
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
			throw new NbtEditError(`Cannot create a ${type} tag.`);
	}
}

/** The tag at `at`, plus how to replace or remove it in its parent. */
export function locate(
	root: Compound,
	at: Path
): { tag: Tag; parent: Tag; key: string | number; replace: (t: Tag) => void; remove: () => void } {
	if (at.length === 0) throw new NbtEditError('The root cannot be changed.');
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

/** The tag at `at`, the root included (an empty path). */
export function tagAt(root: Compound, at: Path): Tag {
	return at.length ? locate(root, at).tag : root;
}

function step(tag: Tag, key: string | number): Tag {
	if (tag.type === 'compound' && typeof key === 'string') {
		const found = child(tag, key);
		if (found) return found;
	}
	if (tag.type === 'list' && typeof key === 'number' && key >= 0 && key < tag.value.length) return tag.value[key];
	throw new NbtEditError('That entry is no longer there. Reload the page and try again.');
}

export function snbtValue(text: string): Tag {
	try {
		return parseSnbt(text);
	} catch (err) {
		throw new NbtEditError(err instanceof SnbtError ? `That SNBT is not valid: ${err.message}.` : 'That SNBT is not valid.');
	}
}

/** One of the tree's edits, applied to `root` in place. */
export function applyTreeEdit(root: Compound, edit: TreeEdit): void {
	switch (edit.op) {
		case 'set': {
			const { tag, parent, replace } = locate(root, edit.path);
			if (tag.type === 'list' || tag.type === 'compound') throw new NbtEditError('Lists and compounds are edited entry by entry.');
			const type = edit.type ?? tag.type;
			if (type !== tag.type && parent.type === 'list') throw new NbtEditError('Every entry of a list has the same type.');
			replace(parseValue(type, edit.value));
			break;
		}
		case 'replace': {
			const { tag, parent, replace } = locate(root, edit.path);
			const value = snbtValue(edit.snbt);
			if (parent.type === 'list' && value.type !== tag.type) {
				if (parent.value.length > 1) throw new NbtEditError(`This list holds ${parent.itemType} entries.`);
				parent.itemType = value.type;
			}
			replace(value);
			break;
		}
		case 'rename': {
			const { parent, key } = locate(root, edit.path);
			const name = edit.name.trim();
			if (parent.type !== 'compound') throw new NbtEditError('Only entries of a compound have names.');
			if (!name) throw new NbtEditError('Give the entry a name.');
			if (name !== key && child(parent, name)) throw new NbtEditError(`There already is an entry called "${name}".`);
			const at = parent.value.findIndex(([n]) => n === key);
			parent.value[at] = [name, parent.value[at][1]];
			break;
		}
		case 'remove':
			locate(root, edit.path).remove();
			break;
		case 'add': {
			const parent = tagAt(root, edit.path);
			const value = edit.type === 'snbt' ? snbtValue(edit.value ?? '') : parseValue(edit.type, edit.value);
			if (parent.type === 'compound') {
				const name = (edit.name ?? '').trim();
				if (!name) throw new NbtEditError('Give the new entry a name.');
				if (child(parent, name)) throw new NbtEditError(`There already is an entry called "${name}".`);
				parent.value.push([name, value]);
			} else if (parent.type === 'list') {
				if (parent.value.length && parent.itemType !== value.type) {
					throw new NbtEditError(`This list holds ${parent.itemType} entries.`);
				}
				parent.itemType = value.type;
				parent.value.push(value);
			} else {
				throw new NbtEditError('Entries can only be added to lists and compounds.');
			}
			break;
		}
	}
}

/** The file written and read again: a typo must fail here, not leave a file nothing can read. */
export function checkWritable(file: NbtFile): Buffer {
	try {
		const bytes = writeNbt(file);
		parseNbt(bytes);
		return bytes;
	} catch (err) {
		throw new NbtEditError(err instanceof NbtError ? err.message : 'The change would make the file unreadable.');
	}
}

/** A tag as the browser gets it: JSON-safe (longs as text, NaN and infinities as text). */
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
