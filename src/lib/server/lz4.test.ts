import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeBlock, readLz4Stream, xxHash32 } from './lz4';
import { parseNbt } from './nbt';
import { HEADER, locations, readChunk, SECTOR } from './regionfile';
import { lz4Stream } from '../../../tests/helpers/regions';

/** Three chunks of a world vanilla 1.21.11 generated with region-file-compression=lz4 (tests/README). */
const FIXTURE = path.join(import.meta.dirname, '../../../tests/fixtures/regions/lz4-1.21.11.mca');

/** The stored bytes of each chunk in the fixture, by index. */
async function fixtureChunks() {
	const file = await fs.readFile(FIXTURE);
	return {
		file,
		chunks: new Map(locations(file.subarray(0, HEADER)).map((loc) => {
			const start = loc.offset * SECTOR;
			return [loc.index, { loc, type: file[start + 4], data: file.subarray(start + 5, start + 4 + file.readUInt32BE(start)) }];
		}))
	};
}

describe('LZ4 chunks', () => {
	it("reads the chunks Minecraft wrote, one of them in two blocks", async () => {
		const { file, chunks } = await fixtureChunks();
		expect([...chunks.keys()]).toEqual([0, 2, 261]);
		for (const [index, { loc, type }] of chunks) {
			expect(type).toBe(4);
			const nbt = await readChunk(path.dirname(FIXTURE), file, [0, 0], loc);
			const root = new Map(parseNbt(nbt!).root.value);
			expect(root.get('DataVersion')).toEqual({ type: 'int', value: 4671 });
			// Each chunk's own position matches its slot: the bytes are the right chunk, whole.
			expect([root.get('xPos'), root.get('zPos')]).toEqual([{ type: 'int', value: index % 32 }, { type: 'int', value: Math.floor(index / 32) }]);
			expect(root.has('sections')).toBe(true);
		}
		// Over 64 KiB unpacked, lz4-java's block size: the second block carries the rest.
		const big = readLz4Stream(chunks.get(261)!.data, Infinity)!;
		expect(big.length).toBeGreaterThan(65536);
	});

	it('takes stored blocks, which lz4-java writes when a block does not shrink', () => {
		const data = Buffer.from(Array.from({ length: 70000 }, (_, i) => (i * 7919) % 251));
		expect(readLz4Stream(lz4Stream(data), Infinity)).toEqual(data);
		expect(readLz4Stream(lz4Stream(Buffer.alloc(0)), Infinity)).toEqual(Buffer.alloc(0));
	});

	it('refuses a damaged chunk instead of returning garbage', async () => {
		const { chunks } = await fixtureChunks();
		const good = chunks.get(0)!.data;
		const flipped = Buffer.from(good);
		flipped[good.length - 40] ^= 1;
		expect(readLz4Stream(flipped, Infinity)).toBeNull();
		expect(readLz4Stream(good.subarray(0, good.length - 21), Infinity), 'no end block').toBeNull();
		expect(readLz4Stream(good.subarray(0, 100), Infinity), 'cut inside a block').toBeNull();
		expect(readLz4Stream(Buffer.from('LZ4Blocx' + 'x'.repeat(40)), Infinity)).toBeNull();
	});

	it('stops at the size limit before unpacking', async () => {
		const { chunks } = await fixtureChunks();
		const data = chunks.get(261)!.data;
		const size = readLz4Stream(data, Infinity)!.length;
		expect(readLz4Stream(data, size)).not.toBeNull();
		expect(readLz4Stream(data, size - 1)).toBeNull();
		// A header claiming 2 GiB is refused, not allocated.
		const claim = Buffer.from(lz4Stream(Buffer.from('abc')));
		claim.writeInt32LE(0x7fffffff, 13);
		expect(readLz4Stream(claim, 64 * 1024 * 1024)).toBeNull();
	});

	it('decodes a block exactly, and refuses one that reaches outside it', () => {
		// "abc" then a match 3 back of length 9 (overlapping itself), then "x".
		const block = Buffer.from([0x35, 0x61, 0x62, 0x63, 0x03, 0x00, 0x10, 0x78]);
		expect(decodeBlock(block, 13)?.toString()).toBe('abcabcabcabcx');
		expect(decodeBlock(block, 12), 'size mismatch').toBeNull();
		expect(decodeBlock(block, 14), 'size mismatch').toBeNull();
		// A match 4 back with only 3 bytes written.
		expect(decodeBlock(Buffer.from([0x35, 0x61, 0x62, 0x63, 0x04, 0x00, 0x10, 0x78]), 13)).toBeNull();
		// Offset 0 is invalid.
		expect(decodeBlock(Buffer.from([0x35, 0x61, 0x62, 0x63, 0x00, 0x00, 0x10, 0x78]), 13)).toBeNull();
		// Literals running past the input.
		expect(decodeBlock(Buffer.from([0x50, 0x61]), 5)).toBeNull();
	});

	it('hashes as xxHash32 does', () => {
		expect(xxHash32(Buffer.alloc(0), 0)).toBe(0x02cc5d05);
		expect(xxHash32(Buffer.from('abc'), 0)).toBe(0x32d153ff);
		expect(xxHash32(Buffer.from('Nobody inspects the spammish repetition'), 0)).toBe(0xe2293b2f);
	});
});
