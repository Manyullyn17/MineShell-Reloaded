/**
 * Reads LZ4 chunks (region compression type 4, `region-file-compression=lz4`,
 * Minecraft 1.20.5+). Minecraft writes them with lz4-java's LZ4BlockOutputStream,
 * which is not the standard LZ4 frame format, so no npm package reads it: a run
 * of blocks, each a 21-byte header - "LZ4Block", a token (method 0x10 stored,
 * 0x20 LZ4, in the high nibble), compressed and decompressed length, and an
 * xxHash32 of the decompressed bytes (seed 0x9747b28c, low 28 bits), all
 * little-endian - then its bytes; an empty block ends the stream.
 *
 * Reading only: MineShell never writes chunks (pruning and restore copy them as
 * stored). Chunks come from the world, so nothing in them is trusted: lengths
 * are checked against the data and the limit, a match never reaches back before
 * the block's start, and a damaged chunk is null rather than garbage.
 */

const MAGIC = Buffer.from('LZ4Block', 'latin1');
const HEADER = MAGIC.length + 13;
const STORED = 0x10;
const LZ4 = 0x20;
const SEED = 0x9747b28c;

/** The decompressed bytes of an LZ4 chunk; null when damaged or over `maxBytes`. */
export function readLz4Stream(data: Buffer, maxBytes: number): Buffer | null {
	const blocks: Buffer[] = [];
	let total = 0;
	let at = 0;
	while (at + HEADER <= data.length) {
		if (!data.subarray(at, at + MAGIC.length).equals(MAGIC)) return null;
		const method = data[at + 8] & 0xf0;
		const compressed = data.readInt32LE(at + 9);
		const size = data.readInt32LE(at + 13);
		const checksum = data.readInt32LE(at + 17) >>> 0;
		at += HEADER;
		if (compressed === 0 && size === 0) return Buffer.concat(blocks, total);
		if (compressed < 0 || size < 0 || at + compressed > data.length || total + size > maxBytes) return null;
		const input = data.subarray(at, at + compressed);
		let block: Buffer | null;
		if (method === STORED) block = compressed === size ? input : null;
		else if (method === LZ4) block = decodeBlock(input, size);
		else return null;
		if (!block || (xxHash32(block, SEED) & 0x0fffffff) !== checksum) return null;
		blocks.push(block);
		total += size;
		at += compressed;
	}
	// No end block: a stream cut short.
	return null;
}

/** One raw LZ4 block, which must decompress to exactly `size` bytes. */
export function decodeBlock(input: Buffer, size: number): Buffer | null {
	const out = Buffer.alloc(size);
	let i = 0;
	let o = 0;
	while (i < input.length) {
		const token = input[i++];
		let literals = token >>> 4;
		if (literals === 15) {
			let b;
			do {
				if (i >= input.length) return null;
				b = input[i++];
				literals += b;
			} while (b === 255);
		}
		if (i + literals > input.length || o + literals > size) return null;
		input.copy(out, o, i, i + literals);
		i += literals;
		o += literals;
		// The last sequence is literals only.
		if (i === input.length) break;
		if (i + 2 > input.length) return null;
		const offset = input[i] | (input[i + 1] << 8);
		i += 2;
		if (offset === 0 || offset > o) return null;
		let length = (token & 15) + 4;
		if ((token & 15) === 15) {
			let b;
			do {
				if (i >= input.length) return null;
				b = input[i++];
				length += b;
			} while (b === 255);
		}
		if (o + length > size) return null;
		// Byte by byte: a match may overlap the bytes it is writing (offset < length repeats them).
		for (let from = o - offset, end = o + length; o < end; ) out[o++] = out[from++];
	}
	return o === size ? out : null;
}

const P1 = 0x9e3779b1;
const P2 = 0x85ebca77;
const P3 = 0xc2b2ae3d;
const P4 = 0x27d4eb2f;
const P5 = 0x165667b1;

const rotl = (x: number, r: number) => (x << r) | (x >>> (32 - r));
const round = (acc: number, lane: number) => Math.imul(rotl((acc + Math.imul(lane, P2)) | 0, 13), P1);

/** xxHash32, as lz4-java checks blocks with it. */
export function xxHash32(data: Buffer, seed: number): number {
	let i = 0;
	let h: number;
	if (data.length >= 16) {
		let v1 = (seed + P1 + P2) | 0;
		let v2 = (seed + P2) | 0;
		let v3 = seed | 0;
		let v4 = (seed - P1) | 0;
		for (; i + 16 <= data.length; i += 16) {
			v1 = round(v1, data.readInt32LE(i));
			v2 = round(v2, data.readInt32LE(i + 4));
			v3 = round(v3, data.readInt32LE(i + 8));
			v4 = round(v4, data.readInt32LE(i + 12));
		}
		h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
	} else h = (seed + P5) | 0;
	h = (h + data.length) | 0;
	for (; i + 4 <= data.length; i += 4) h = Math.imul(rotl((h + Math.imul(data.readInt32LE(i), P3)) | 0, 17), P4);
	for (; i < data.length; i++) h = Math.imul(rotl((h + Math.imul(data[i], P5)) | 0, 11), P1);
	h = Math.imul(h ^ (h >>> 15), P2);
	h = Math.imul(h ^ (h >>> 13), P3);
	return (h ^ (h >>> 16)) >>> 0;
}
