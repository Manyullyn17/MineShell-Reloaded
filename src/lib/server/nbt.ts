import zlib from 'node:zlib';
import type { TagType } from '#lib/shared/nbt.js';

/**
 * Minecraft's NBT: big-endian, named tags, strings in Java's modified UTF-8.
 * Player .dat files are gzipped. Parsed into a typed tree that writes back
 * byte for byte - every tag keeps its type, compounds keep their order (as
 * entries, not an object: a JS object would move numeric keys first), longs
 * stay bigint.
 */

export type { TagType };

export type Tag =
	| { type: 'byte' | 'short' | 'int' | 'float' | 'double'; value: number }
	| { type: 'long'; value: bigint }
	| { type: 'string'; value: string }
	| { type: 'byteArray' | 'intArray'; value: number[] }
	| { type: 'longArray'; value: bigint[] }
	| { type: 'list'; itemType: TagType; value: Tag[] }
	| { type: 'compound'; value: [string, Tag][] };

export type Compound = Extract<Tag, { type: 'compound' }>;

export const TAG_IDS: TagType[] = [
	'end',
	'byte',
	'short',
	'int',
	'long',
	'float',
	'double',
	'byteArray',
	'string',
	'list',
	'compound',
	'intArray',
	'longArray'
];

export class NbtError extends Error {}

// ------------------------------------------------------------------ reading ---

class Reader {
	pos = 0;
	private buf: Buffer;
	constructor(buf: Buffer) {
		this.buf = buf;
	}

	private need(n: number) {
		if (this.pos + n > this.buf.length) throw new NbtError('The file ends in the middle of a tag.');
	}
	byte() {
		this.need(1);
		return this.buf.readInt8(this.pos++);
	}
	short() {
		this.need(2);
		const v = this.buf.readInt16BE(this.pos);
		this.pos += 2;
		return v;
	}
	int() {
		this.need(4);
		const v = this.buf.readInt32BE(this.pos);
		this.pos += 4;
		return v;
	}
	long() {
		this.need(8);
		const v = this.buf.readBigInt64BE(this.pos);
		this.pos += 8;
		return v;
	}
	float() {
		this.need(4);
		const v = this.buf.readFloatBE(this.pos);
		this.pos += 4;
		return v;
	}
	double() {
		this.need(8);
		const v = this.buf.readDoubleBE(this.pos);
		this.pos += 8;
		return v;
	}
	string() {
		this.need(2);
		const length = this.buf.readUInt16BE(this.pos);
		this.pos += 2;
		this.need(length);
		const s = decodeModifiedUtf8(this.buf.subarray(this.pos, this.pos + length));
		this.pos += length;
		return s;
	}
	count() {
		const n = this.int();
		if (n < 0) throw new NbtError('A negative length in the file.');
		return n;
	}
	tagType(): TagType {
		const id = this.byte();
		const type = TAG_IDS[id];
		if (!type) throw new NbtError(`Unknown tag type ${id}.`);
		return type;
	}

	payload(type: TagType, depth: number): Tag {
		if (depth > 512) throw new NbtError('Tags nested too deeply.');
		switch (type) {
			case 'byte':
				return { type, value: this.byte() };
			case 'short':
				return { type, value: this.short() };
			case 'int':
				return { type, value: this.int() };
			case 'long':
				return { type, value: this.long() };
			case 'float':
				return { type, value: this.float() };
			case 'double':
				return { type, value: this.double() };
			case 'string':
				return { type, value: this.string() };
			case 'byteArray': {
				const n = this.count();
				const value: number[] = [];
				for (let i = 0; i < n; i++) value.push(this.byte());
				return { type, value };
			}
			case 'intArray': {
				const n = this.count();
				const value: number[] = [];
				for (let i = 0; i < n; i++) value.push(this.int());
				return { type, value };
			}
			case 'longArray': {
				const n = this.count();
				const value: bigint[] = [];
				for (let i = 0; i < n; i++) value.push(this.long());
				return { type, value };
			}
			case 'list': {
				const itemType = this.tagType();
				const n = this.count();
				if (itemType === 'end' && n > 0) throw new NbtError('A list of end tags.');
				const value: Tag[] = [];
				for (let i = 0; i < n; i++) value.push(this.payload(itemType, depth + 1));
				return { type, itemType, value };
			}
			case 'compound': {
				const value: [string, Tag][] = [];
				for (;;) {
					const child = this.tagType();
					if (child === 'end') break;
					value.push([this.string(), this.payload(child, depth + 1)]);
				}
				return { type, value };
			}
			case 'end':
				throw new NbtError('An end tag where a value belongs.');
		}
	}
}

/** Java's DataInput.readUTF: NUL as C0 80, characters beyond the BMP as two encoded surrogates. */
function decodeModifiedUtf8(bytes: Buffer): string {
	let out = '';
	for (let i = 0; i < bytes.length; ) {
		const a = bytes[i];
		if (a < 0x80) {
			out += String.fromCharCode(a);
			i += 1;
		} else if ((a & 0xe0) === 0xc0 && i + 1 < bytes.length) {
			out += String.fromCharCode(((a & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
			i += 2;
		} else if ((a & 0xf0) === 0xe0 && i + 2 < bytes.length) {
			out += String.fromCharCode(((a & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
			i += 3;
		} else {
			throw new NbtError('A string that is not valid modified UTF-8.');
		}
	}
	return out;
}

function encodeModifiedUtf8(text: string): Buffer {
	const bytes: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c >= 0x01 && c <= 0x7f) bytes.push(c);
		else if (c <= 0x7ff) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
		else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
	}
	if (bytes.length > 0xffff) throw new NbtError('A string longer than NBT allows (65535 bytes).');
	return Buffer.from(bytes);
}

export type NbtFile = { name: string; root: Compound; gzipped: boolean };

export function parseNbt(data: Buffer): NbtFile {
	const gzipped = data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
	const raw = gzipped ? zlib.gunzipSync(data) : data;
	const reader = new Reader(raw);
	if (reader.tagType() !== 'compound') throw new NbtError('The file does not start with a compound tag.');
	const name = reader.string();
	const root = reader.payload('compound', 0) as Compound;
	return { name, root, gzipped };
}

// ------------------------------------------------------------------ writing ---

class Writer {
	private chunks: Buffer[] = [];

	private push(size: number, write: (b: Buffer) => void) {
		const b = Buffer.alloc(size);
		write(b);
		this.chunks.push(b);
	}
	byte(v: number) {
		this.push(1, (b) => b.writeInt8(v));
	}
	short(v: number) {
		this.push(2, (b) => b.writeInt16BE(v));
	}
	int(v: number) {
		this.push(4, (b) => b.writeInt32BE(v));
	}
	long(v: bigint) {
		this.push(8, (b) => b.writeBigInt64BE(v));
	}
	float(v: number) {
		this.push(4, (b) => b.writeFloatBE(v));
	}
	double(v: number) {
		this.push(8, (b) => b.writeDoubleBE(v));
	}
	string(v: string) {
		const bytes = encodeModifiedUtf8(v);
		this.push(2, (b) => b.writeUInt16BE(bytes.length));
		this.chunks.push(bytes);
	}

	payload(tag: Tag) {
		switch (tag.type) {
			case 'byte':
				return this.byte(tag.value);
			case 'short':
				return this.short(tag.value);
			case 'int':
				return this.int(tag.value);
			case 'long':
				return this.long(tag.value);
			case 'float':
				return this.float(tag.value);
			case 'double':
				return this.double(tag.value);
			case 'string':
				return this.string(tag.value);
			case 'byteArray':
				this.int(tag.value.length);
				return tag.value.forEach((v) => this.byte(v));
			case 'intArray':
				this.int(tag.value.length);
				return tag.value.forEach((v) => this.int(v));
			case 'longArray':
				this.int(tag.value.length);
				return tag.value.forEach((v) => this.long(v));
			case 'list': {
				for (const item of tag.value) {
					if (item.type !== tag.itemType) throw new NbtError(`A ${item.type} in a list of ${tag.itemType}.`);
				}
				this.byte(TAG_IDS.indexOf(tag.itemType));
				this.int(tag.value.length);
				return tag.value.forEach((v) => this.payload(v));
			}
			case 'compound':
				for (const [name, child] of tag.value) {
					this.byte(TAG_IDS.indexOf(child.type));
					this.string(name);
					this.payload(child);
				}
				return this.byte(0);
		}
	}

	result() {
		return Buffer.concat(this.chunks);
	}
}

export function writeNbt(file: NbtFile): Buffer {
	const w = new Writer();
	w.byte(TAG_IDS.indexOf('compound'));
	w.string(file.name);
	w.payload(file.root);
	const raw = w.result();
	return file.gzipped ? zlib.gzipSync(raw) : raw;
}

// ------------------------------------------------------------------ helpers ---

/** A compound's child by name. */
export function child(tag: Tag | undefined, name: string): Tag | undefined {
	return tag?.type === 'compound' ? tag.value.find(([n]) => n === name)?.[1] : undefined;
}

/** Set (replacing in place, so the order stays) or add a compound's child. */
export function setChild(tag: Compound, name: string, value: Tag): void {
	const at = tag.value.findIndex(([n]) => n === name);
	if (at >= 0) tag.value[at] = [name, value];
	else tag.value.push([name, value]);
}

export function removeChild(tag: Compound, name: string): boolean {
	const at = tag.value.findIndex(([n]) => n === name);
	if (at < 0) return false;
	tag.value.splice(at, 1);
	return true;
}

/** A numeric tag's value as a number (longs included, where they fit). */
export function num(tag: Tag | undefined): number | null {
	if (!tag) return null;
	if (tag.type === 'long') return Number(tag.value);
	return typeof tag.value === 'number' ? tag.value : null;
}

export function str(tag: Tag | undefined): string | null {
	return tag?.type === 'string' ? tag.value : null;
}

/** The shortest decimal that is the same 32-bit float: 0.1, not 0.10000000149011612. */
export function shortestFloat(value: number): number {
	for (let digits = 1; digits <= 9; digits++) {
		const candidate = Number(value.toPrecision(digits));
		if (Math.fround(candidate) === value) return candidate;
	}
	return value;
}
