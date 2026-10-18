import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { chunkTops, chunkUnderRoof, readRegionColumns, regionOverview, roofTuning, shrinkColumns, type RegionColumns } from './chunkmap';
import { writeRegion } from '../../../tests/helpers/regions';
import { decodePng } from './png';
import type { Tag } from './nbt';

type Compound = Extract<Tag, { type: 'compound' }>;
const compound = (entries: [string, Tag][]): Compound => ({ type: 'compound', value: entries });
const int = (value: number): Tag => ({ type: 'int', value });
const byte = (value: number): Tag => ({ type: 'byte', value });
const string = (value: string): Tag => ({ type: 'string', value });
const list = (value: Tag[]): Tag => ({ type: 'list', itemType: value[0]?.type ?? 'end', value } as Tag);

/** Palette indices (4096, y*256 + z*16 + x) packed into longs, as the game does: spanning before 1.16. */
function pack(indices: number[], bits: number, spanning: boolean): bigint[] {
	const longs: bigint[] = [];
	if (spanning) {
		const total = Math.ceil((4096 * bits) / 64);
		for (let i = 0; i < total; i++) longs.push(0n);
		indices.forEach((v, i) => {
			const bit = i * bits;
			const at = Math.floor(bit / 64);
			const off = BigInt(bit % 64);
			longs[at] |= (BigInt(v) << off) & 0xffffffffffffffffn;
			if (bit % 64 + bits > 64) longs[at + 1] |= BigInt(v) >> (64n - off);
		});
	} else {
		const per = Math.floor(64 / bits);
		for (let i = 0; i < Math.ceil(4096 / per); i++) longs.push(0n);
		indices.forEach((v, i) => (longs[Math.floor(i / per)] |= BigInt(v) << BigInt((i % per) * bits)));
	}
	// Stored as signed longs.
	return longs.map((l) => BigInt.asIntN(64, l));
}

/** A section where `block(x, y, z)` gives the palette index. */
function indices(block: (x: number, y: number, z: number) => number): number[] {
	const out: number[] = [];
	for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) out.push(block(x, y, z));
	return out;
}

const state = (name: string) => compound([['Name', string(name)]]);

describe('chunk map: top blocks', () => {
	// Section 0 of every chunk: stone up to y 3, then at x 0 water two deep over sand, at x 1 grass at y 4,
	// and eighteen palette entries so indices take five bits (spanning longs before 1.16).
	const palette = ['minecraft:air', 'minecraft:stone', 'minecraft:water', 'minecraft:sand', 'minecraft:grass_block', ...Array.from({ length: 13 }, (_, i) => `minecraft:filler_${i}`)];
	const layout = (x: number, y: number) => (y <= 3 ? 1 : x === 0 && y === 4 ? 3 : x === 0 && y <= 6 ? 2 : x === 1 && y === 4 ? 4 : 0);

	it('reads 1.18+ sections', () => {
		const root = compound([
			['DataVersion', int(3955)],
			['sections', list([
				compound([['Y', byte(-1)], ['block_states', compound([['palette', list([state('minecraft:deepslate')])]])]]),
				compound([['Y', byte(0)], ['block_states', compound([['palette', list(palette.map(state))], ['data', { type: 'longArray', value: pack(indices(layout), 5, false) }]])]]),
				compound([['Y', byte(1)], ['block_states', compound([['palette', list([state('minecraft:air')])]])]])
			])]
		]);
		const tops = chunkTops(root, null)!;
		expect(tops[0]).toEqual({ key: 'minecraft:water', y: 6, depth: 1 });
		expect(tops[1]).toEqual({ key: 'minecraft:grass_block', y: 4, depth: 0 });
		expect(tops[2]).toEqual({ key: 'minecraft:stone', y: 3, depth: 0 });
	});

	it('reads 1.13-1.15 sections, whose indices span longs', () => {
		const root = compound([
			['DataVersion', int(1976)],
			['Level', compound([['Sections', list([compound([['Y', byte(0)], ['Palette', list(palette.map(state))], ['BlockStates', { type: 'longArray', value: pack(indices(layout), 5, true) }]])])]])]
		]);
		const tops = chunkTops(root, null)!;
		expect(tops[0]).toEqual({ key: 'minecraft:water', y: 6, depth: 1 });
		expect(tops[1]?.key).toBe('minecraft:grass_block');
		expect(tops[2]?.key).toBe('minecraft:stone');
	});

	const nibbles = (values: number[]) => {
		const out = new Array(2048).fill(0);
		values.forEach((v, i) => (out[i >> 1] |= (v & 15) << (i & 1 ? 4 : 0)));
		return out.map((b) => (b > 127 ? b - 256 : b));
	};
	const bytes = (values: number[]) => values.map((v) => (v & 255) > 127 ? (v & 255) - 256 : v & 255);

	it('reads 1.12 numbers through the world registry, with Add and Data', () => {
		// Stone (1) with granite (meta 1) at x 2, a mod block numbered 300 (Add carries the 1) at x 3.
		const ids = new Map([[1, 'minecraft:stone'], [300, 'mymod:marble']]);
		const blockOf = (x: number, y: number) => (y <= 3 ? (x === 3 && y === 3 ? 300 : 1) : 0);
		const all = indices(blockOf);
		const root = compound([
			['DataVersion', int(1343)],
			['Level', compound([['Sections', list([compound([
				['Y', byte(0)],
				['Blocks', { type: 'byteArray', value: bytes(all) }],
				['Add', { type: 'byteArray', value: nibbles(all.map((b) => b >> 8)) }],
				['Data', { type: 'byteArray', value: nibbles(indices((x, y) => (x === 2 && y === 3 ? 1 : 0))) }]
			])])]])]
		]);
		const tops = chunkTops(root, ids)!;
		expect(tops[0]).toEqual({ key: 'minecraft:stone@0', y: 3, depth: 0 });
		expect(tops[2]?.key).toBe('minecraft:stone@1');
		expect(tops[3]?.key).toBe('mymod:marble@0');
	});

	it('reads RoughlyEnoughIDs sections, whose Blocks and Data index a palette of numbers', () => {
		// Palette: air, stone, diorite (1:3), a mod block numbered 5000 with meta 2.
		const states = [0, 1 << 4, (1 << 4) | 3, (5000 << 4) | 2];
		const ids = new Map([[1, 'minecraft:stone'], [5000, 'bigmod:crystal']]);
		const index = indices((x, y) => (y <= 2 ? (x === 4 ? 2 : x === 5 && y === 2 ? 3 : 1) : 0));
		const root = compound([
			['DataVersion', int(1343)],
			['Level', compound([['Sections', list([compound([
				['Y', byte(0)],
				['Blocks', { type: 'byteArray', value: bytes(index.map((i) => i >> 4)) }],
				['Data', { type: 'byteArray', value: nibbles(index) }],
				['Palette', { type: 'intArray', value: states }]
			])])]])]
		]);
		const tops = chunkTops(root, ids)!;
		expect(tops[0]).toEqual({ key: 'minecraft:stone@0', y: 2, depth: 0 });
		expect(tops[4]?.key).toBe('minecraft:stone@3');
		expect(tops[5]?.key).toBe('bigmod:crystal@2');
	});

	it('names numbers the world registry lacks by number, and a chunk without sections as nothing', () => {
		const root = compound([
			['Level', compound([['Sections', list([compound([['Y', byte(0)], ['Blocks', { type: 'byteArray', value: bytes(indices((x, y) => (y === 0 ? 77 : 0))) }]])])]])]
		]);
		expect(chunkTops(root, new Map())![0]?.key).toBe('#77@0');
		expect(chunkTops(compound([['DataVersion', int(3955)]]), null)).toBeNull();
	});
});

/**
 * A 1.18+ chunk whose blocks depend only on height (and x, for walls): `at(y, x)` names the block.
 * Sections that are all air are left out, as the game does.
 */
function layered(at: (y: number, x: number) => string, sectionsY: number[]): Compound {
	const sections = sectionsY.map((sy) => {
		const names: string[] = [];
		const index = indices((x, y) => {
			const name = at(sy * 16 + y, x);
			if (!names.includes(name)) names.push(name);
			return names.indexOf(name);
		});
		const palette = [...names, ...Array.from({ length: Math.max(0, 17 - names.length) }, (_, i) => `minecraft:pad_${i}`)];
		return compound([['Y', byte(sy)], ['block_states', compound([['palette', list(palette.map(state))], ['data', { type: 'longArray', value: pack(index, 5, false) }]])]]);
	});
	return compound([['DataVersion', int(3955)], ['sections', list(sections.filter((sec) => {
		const pal = (sec.value[1][1] as Compound).value[0][1] as Extract<Tag, { type: 'list' }>;
		return pal.value.some((st) => !((st as Compound).value[0][1] as { value: string }).value.match(/air|pad_/));
	}))]]);
}

describe('chunk map: below a roof', () => {
	// A Nether in 32 blocks: roof at 31, its mass down to 20 with a 2-block pocket at 26-27, a cavern 10-19, a floor of stone.
	const nether = (y: number) =>
		y === 31 ? 'minecraft:bedrock' : y >= 28 ? 'minecraft:netherrack' : y >= 26 ? 'minecraft:air' : y >= 20 ? 'minecraft:netherrack' : y >= 10 ? 'minecraft:air' : 'minecraft:stone';

	it('goes down through the roof, whatever it is made of, to the floor under the first open space', () => {
		const root = layered(nether, [0, 1]);
		expect(chunkUnderRoof(root, null, 31, 1)![0]).toEqual({ top: { key: 'minecraft:netherrack', y: 25, depth: 0 }, floor: true });
		// Pockets shorter than minGap are passed through: the cavern's floor.
		expect(chunkUnderRoof(root, null, 31, 3)![0]).toEqual({ top: { key: 'minecraft:stone', y: 9, depth: 0 }, floor: true });
	});

	it('shows a wall up to the roof by the block under it, and counts a missing section as air', () => {
		// The roof (47) and section 2 solid, section 1 missing (all air, so not in the file), stone up to 15.
		const root = layered((y) => (y === 47 ? 'minecraft:bedrock' : y >= 32 ? 'minecraft:netherrack' : y <= 15 ? 'minecraft:stone' : 'minecraft:air'), [0, 2]);
		expect(chunkUnderRoof(root, null, 47, 1)![0]).toEqual({ top: { key: 'minecraft:stone', y: 15, depth: 0 }, floor: true });
		// Solid from the roof to the bottom (a dungeon's wall): the block under the roof.
		const solid = layered((y) => (y === 15 ? 'minecraft:bedrock' : 'minecraft:bricks'), [0]);
		expect(chunkUnderRoof(solid, null, 15, 1)![0]).toEqual({ top: { key: 'minecraft:bricks', y: 14, depth: 0 }, floor: false });
	});

	it('finds a roof over a region, but not on a superflat world or an ocean', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chunkmap-roof-'));
		const region = async (at: (y: number) => string) => {
			await writeRegion(dir, 0, 0, [0, 1, 2, 3].map((index) => ({ index, root: layered(at, [0, 1]) })));
			return (await readRegionColumns(dir, 'r.0.0.mca', null))!;
		};
		const roofed = await region(nether);
		expect(roofed.roof).toBe(31);
		expect(roofed.keys[roofed.under!.blocks[0] - 1]).toBe('minecraft:netherrack');
		expect(roofed.keys[roofed.blocks[0] - 1]).toBe('minecraft:bedrock');
		// Flat on top too, but solid all the way down: nothing to show under it.
		expect((await region((y) => (y <= 4 ? 'minecraft:grass_block' : 'minecraft:air'))).roof).toBeNull();
		// Flat water, with air below would not be one either.
		expect((await region((y) => (y >= 20 && y <= 25 ? 'minecraft:water' : y < 5 ? 'minecraft:sand' : 'minecraft:air'))).roof).toBeNull();
		expect(roofTuning.minGap).toBe(1);
		await fs.rm(dir, { recursive: true, force: true });
	});
});

describe('chunk map: a region', () => {
	it('tells chunks generated only partway from unreadable ones, with how far they got', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chunkmap-'));
		const stone = compound([['Y', byte(0)], ['block_states', compound([['palette', list([state('minecraft:stone')])]])]]);
		const air = compound([['Y', byte(0)], ['block_states', compound([['palette', list([state('minecraft:air')])]])]]);
		const chunk = (status: string, sections: Tag[]) =>
			compound([['DataVersion', int(4671)], ['Status', string(status)], ...(sections.length ? [['sections', list(sections)] as [string, Tag]] : [])]);
		await writeRegion(dir, 0, 0, [
			{ index: 0, root: chunk('minecraft:full', [stone]) },
			// The ring 1.18+ leaves around loaded chunks: biomes but no blocks, or no sections at all yet.
			{ index: 1, root: chunk('minecraft:biomes', [air]) },
			{ index: 2, root: chunk('minecraft:structure_starts', []) },
			{ index: 3, compression: 4 }
		]);
		const columns = (await readRegionColumns(dir, 'r.0.0.mca', null))!;
		expect(columns.keys).toEqual(['minecraft:stone']);
		expect(columns.bare).toEqual({ 1: 'biomes', 2: 'structure_starts' });
		expect(columns.unreadable).toEqual([3]);
		await fs.rm(dir, { recursive: true, force: true });
	});
});

describe('chunk map: overview', () => {
	it('lists region files with the chunks they hold', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chunkmap-'));
		await fs.mkdir(path.join(dir, 'region'));
		const header = Buffer.alloc(8192);
		header.writeUInt32BE((2 << 8) | 1, 0 * 4);
		header.writeUInt32BE((3 << 8) | 1, 33 * 4);
		await fs.writeFile(path.join(dir, 'region', 'r.-1.2.mca'), Buffer.concat([header, Buffer.alloc(8192)]));
		await fs.writeFile(path.join(dir, 'region', 'r.0.0.mca'), Buffer.alloc(8192));
		await fs.writeFile(path.join(dir, 'region', 'r.5.5.mca'), Buffer.alloc(100));
		const regions = await regionOverview(dir);
		expect(regions.map((r) => [r.x, r.z])).toEqual([[-1, 2]]);
		const bits = Buffer.from(regions[0].chunks, 'base64');
		expect(bits[0]).toBe(1);
		expect(bits[4]).toBe(2);
		await fs.rm(dir, { recursive: true, force: true });
	});
});

describe('chunk map: the zoomed-out picture', () => {
	it('keeps the middle column of every 8x8 cell', () => {
		const full: RegionColumns = { keys: ['a', 'b'], unreadable: [3], bare: { 5: 'biomes' }, roof: null, under: null, blocks: new Uint16Array(512 * 512), heights: new Int16Array(512 * 512), depths: new Uint8Array(512 * 512) };
		// Cell (1, 2) has its middle at x 12, z 20; the cell's corner is different and must not show.
		full.blocks[20 * 512 + 12] = 2;
		full.heights[20 * 512 + 12] = 70;
		full.depths[20 * 512 + 12] = 3;
		full.blocks[16 * 512 + 8] = 1;
		const small = shrinkColumns(full, 8);
		expect(small.size).toBe(64);
		expect([small.blocks[2 * 64 + 1], small.heights[2 * 64 + 1], small.depths[2 * 64 + 1]]).toEqual([2, 70, 3]);
		expect([small.unreadable, small.bare]).toEqual([[3], { 5: 'biomes' }]);
		expect(small.blocks.filter((b) => b).length).toBe(1);
		expect(small.unreadable).toEqual([3]);
	});
});

describe('png decoding', () => {
	function png(width: number, height: number, type: number, depth: number, rows: number[][], extra: [string, Buffer][] = []): Buffer {
		const chunk = (name: string, body: Buffer) => {
			const len = Buffer.alloc(4);
			len.writeUInt32BE(body.length);
			return Buffer.concat([len, Buffer.from(name), body, Buffer.alloc(4)]);
		};
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(width, 0);
		ihdr.writeUInt32BE(height, 4);
		ihdr[8] = depth;
		ihdr[9] = type;
		const raw = Buffer.from(rows.flatMap((r) => r));
		return Buffer.concat([
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			chunk('IHDR', ihdr),
			...extra.map(([n, b]) => chunk(n, b)),
			chunk('IDAT', zlib.deflateSync(raw)),
			chunk('IEND', Buffer.alloc(0))
		]);
	}

	it('decodes RGBA with every filter', () => {
		// Two pixels a row; filters none, sub, up, average, paeth all give the same picture.
		const row = [10, 20, 30, 255, 40, 50, 60, 128];
		const rows = [
			[0, ...row],
			[1, 10, 20, 30, 255, 30, 30, 30, 129],
			[2, 0, 0, 0, 0, 0, 0, 0, 0],
			[3, 10 - 5, 20 - 10, 30 - 15, 255 - 127, 40 - 25, 50 - 35, 60 - 45, (128 - 191) & 255],
			[4, 0, 0, 0, 0, 0, 0, 0, 0]
		];
		const decoded = decodePng(png(2, 5, 6, 8, rows))!;
		for (let y = 0; y < 5; y++) expect([...decoded.data.subarray(y * 8, y * 8 + 8)]).toEqual(row);
	});

	it('decodes a 2-bit palette with transparency', () => {
		const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
		const decoded = decodePng(png(3, 1, 3, 2, [[0, 0b00011000]], [['PLTE', palette], ['tRNS', Buffer.from([255, 0])]]))!;
		expect([...decoded.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255]);
	});
});
