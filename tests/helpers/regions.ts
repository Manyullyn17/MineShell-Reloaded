import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { inhabitedTime } from '#lib/server/chunkprune.js';
import { readLz4Stream, xxHash32 } from '#lib/server/lz4.js';
import { parseNbt, writeNbt, type Tag } from '#lib/server/nbt.js';

/**
 * Region files in Minecraft's format for tests. A chunk carries only its
 * InhabitedTime (and padding to make it big), which doubles as a marker of
 * which file a chunk came from.
 */

const SECTOR = 4096;

export type ChunkSpec = {
	index: number;
	ticks?: number;
	legacy?: boolean;
	/** 1 gzip, 2 zlib (the default), 3 none, 4 LZ4. */
	compression?: number;
	/** Bytes no decompressor takes, as a damaged chunk has. */
	damaged?: boolean;
	external?: boolean;
	pad?: number;
	/** Small compounds to parse, as a real chunk's sections and block entities make it slow to read. */
	busy?: number;
	/** The chunk's NBT as given, instead of one made from the fields above. */
	root?: Extract<Tag, { type: 'compound' }>;
};

/** A chunk's NBT: 1.18+ keeps InhabitedTime at the top, 1.12-1.17 under Level. */
function chunkNbt(spec: ChunkSpec): Buffer {
	if (spec.root) return writeNbt({ name: '', gzipped: false, root: spec.root });
	const fields: [string, Tag][] = [
		['InhabitedTime', { type: 'long', value: BigInt(spec.ticks ?? 0) }],
		['Padding', { type: 'byteArray', value: new Array(spec.pad ?? 0).fill(1) }]
	];
	if (spec.busy) {
		const entry = (n: number): Tag => ({ type: 'compound', value: [['x', { type: 'int', value: n }], ['id', { type: 'string', value: `minecraft:stone_${n}` }]] });
		fields.push(['Busy', { type: 'list', itemType: 'compound', value: Array.from({ length: spec.busy }, (_, n) => entry(n)) } as Tag]);
	}
	const root: Tag = spec.legacy
		? { type: 'compound', value: [['Level', { type: 'compound', value: fields }]] }
		: { type: 'compound', value: [['DataVersion', { type: 'int', value: 3955 }], ...fields] };
	return writeNbt({ name: '', gzipped: false, root: root as Extract<Tag, { type: 'compound' }> });
}

/**
 * An LZ4 chunk as lz4-java frames it, with its blocks stored rather than
 * compressed (a valid stream, which the reader takes the same way); real LZ4
 * blocks come from a world Minecraft wrote (tests/fixtures/regions).
 */
export function lz4Stream(data: Buffer, blockSize = 65536): Buffer {
	const parts: Buffer[] = [];
	const header = (method: number, block: Buffer) => {
		const h = Buffer.alloc(21);
		h.write('LZ4Block', 'latin1');
		h[8] = method | 6;
		h.writeInt32LE(block.length, 9);
		h.writeInt32LE(block.length, 13);
		h.writeInt32LE(block.length ? xxHash32(block, 0x9747b28c) & 0x0fffffff : 0, 17);
		return h;
	};
	for (let at = 0; at < data.length; at += blockSize) {
		const block = data.subarray(at, at + blockSize);
		parts.push(header(0x10, block), block);
	}
	parts.push(header(0x10, Buffer.alloc(0)));
	return Buffer.concat(parts);
}

function compress(compression: number, nbt: Buffer): Buffer {
	if (compression === 1) return zlib.gzipSync(nbt);
	if (compression === 2) return zlib.deflateSync(nbt);
	if (compression === 4) return lz4Stream(nbt);
	return nbt;
}

/** A stored chunk's NBT bytes, by its compression byte. */
function decompress(compression: number, data: Buffer): Buffer {
	if (compression === 1) return zlib.gunzipSync(data);
	if (compression === 2) return zlib.inflateSync(data);
	if (compression === 4) return readLz4Stream(data, Infinity)!;
	return data;
}

/** Writes r.<rx>.<rz>.mca in Minecraft's format; an `external` chunk goes to c.<x>.<z>.mcc. */
export async function writeRegion(dir: string, rx: number, rz: number, chunks: ChunkSpec[]): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	const header = Buffer.alloc(2 * SECTOR);
	const bodies: Buffer[] = [];
	let next = 2;
	for (const spec of chunks) {
		const compression = spec.compression ?? 2;
		const data = spec.damaged ? Buffer.from('not a chunk') : compress(compression, chunkNbt(spec));
		let payload: Buffer;
		if (spec.external) {
			await fs.writeFile(path.join(dir, `c.${rx * 32 + (spec.index % 32)}.${rz * 32 + Math.floor(spec.index / 32)}.mcc`), data);
			payload = Buffer.from([0, 0, 0, 1, compression | 128]);
		} else {
			payload = Buffer.concat([Buffer.alloc(4), Buffer.from([compression]), data]);
			payload.writeUInt32BE(data.length + 1, 0);
		}
		const sectors = Math.ceil(payload.length / SECTOR);
		const body = Buffer.alloc(sectors * SECTOR);
		payload.copy(body);
		header.writeUInt32BE(((next << 8) | sectors) >>> 0, spec.index * 4);
		header.writeUInt32BE(1_700_000_000, SECTOR + spec.index * 4);
		bodies.push(body);
		next += sectors;
	}
	await fs.writeFile(path.join(dir, `r.${rx}.${rz}.mca`), Buffer.concat([header, ...bodies]));
}

/** InhabitedTime of every chunk still in a region file, by index, whatever its compression; external chunks are read from their .mcc. */
export async function readRegion(file: string): Promise<Record<number, number>> {
	const buf = await fs.readFile(file);
	const [rx, rz] = path.basename(file).split('.').slice(1, 3).map(Number);
	const found: Record<number, number> = {};
	for (let index = 0; index < 1024; index++) {
		const entry = buf.readUInt32BE(index * 4);
		if (!entry) continue;
		const start = (entry >>> 8) * SECTOR;
		const length = buf.readUInt32BE(start);
		const data =
			buf[start + 4] & 128
				? await fs.readFile(path.join(path.dirname(file), `c.${rx * 32 + (index % 32)}.${rz * 32 + Math.floor(index / 32)}.mcc`))
				: buf.subarray(start + 5, start + 4 + length);
		found[index] = inhabitedTime(parseNbt(decompress(buf[start + 4] & 127, data)).root)!;
	}
	return found;
}
