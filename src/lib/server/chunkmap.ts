import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { CACHE_DIR } from './config';
import { child, num, parseNbt, str, type Tag } from './nbt';
import { blockLook, type IconSpec, type Resources } from './itemicons';
import { decodePng } from './png';
import { HEADER, locations, presentChunks, readChunk, REGION_NAME, regionOf } from './regionfile';

/**
 * The chunk map (World > Restore chunks): a flat top-down picture of a
 * dimension, one pixel per block column, drawn in the browser from what this
 * reads.
 *
 * - The overview is every region file's header: which chunks exist. Cheap
 *   enough for a whole world at once.
 * - A region's detail is the top block of each of its 512x512 columns, its
 *   height, and how deep the water is there. Read from the chunks' block
 *   data in every format: 1.18+ `sections` and 1.13-1.17 `Level.Sections`
 *   (palettes over packed indices; before 1.16 an index may span two longs),
 *   1.12 and older `Blocks`/`Add`/`Data` (numbers, named through Forge's
 *   registry in level.dat or vanilla's table), and RoughlyEnoughIDs/JEID's
 *   1.12 sections, whose `Palette` holds the numbers and Blocks/Add/Data the
 *   index into it. Decoded columns are cached on disk by file size and time.
 * - Colours: each block's top face texture, averaged and tinted, through the
 *   item icon index (`blockLook`); names the same way. A block without a
 *   texture there is drawn by the browser as plain shading.
 */

const CACHE = path.join(CACHE_DIR, 'chunkmap');
const SIZE = 512;
const AREA = SIZE * SIZE;
/** Bumped when the cached format changes (2: `bare`; 3: `roof` and `under`; 4: `partial`). */
const CACHE_VERSION = 4;

// ------------------------------------------------------------- overview ---

export type RegionSummary = { x: number; z: number; chunks: string; bytes: number };

/**
 * Every region file of a dimension folder (the one holding region/), with its
 * chunks as a 1024-bit list in base64 and its size (pre-generation's disk estimate).
 */
export async function regionOverview(base: string): Promise<RegionSummary[]> {
	const dir = path.join(base, 'region');
	const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => REGION_NAME.test(n));
	const out: RegionSummary[] = [];
	for (const name of names) {
		const handle = await fs.open(path.join(dir, name), 'r').catch(() => null);
		if (!handle) continue;
		try {
			const header = Buffer.alloc(HEADER);
			const { bytesRead } = await handle.read(header, 0, HEADER, 0);
			if (bytesRead < HEADER) continue;
			const present = presentChunks(header);
			const bits = Buffer.alloc(128);
			for (let i = 0; i < 1024; i++) if (present[i]) bits[i >> 3] |= 1 << (i & 7);
			if (!bits.some((b) => b)) continue;
			const [x, z] = regionOf(name)!;
			out.push({ x, z, chunks: bits.toString('base64'), bytes: (await handle.stat()).size });
		} finally {
			await handle.close();
		}
	}
	return out.sort((a, b) => a.z - b.z || a.x - b.x);
}

// ------------------------------------------------------- block numbers ---

/** Vanilla's block numbers before 1.13 (1.12.2; 1.7 is a prefix of it), from 0. */
const VANILLA_BLOCKS =
	'air stone grass dirt cobblestone planks sapling bedrock flowing_water water flowing_lava lava sand gravel gold_ore ' +
	'iron_ore coal_ore log leaves sponge glass lapis_ore lapis_block dispenser sandstone noteblock bed golden_rail ' +
	'detector_rail sticky_piston web tallgrass deadbush piston piston_head wool piston_extension yellow_flower red_flower ' +
	'brown_mushroom red_mushroom gold_block iron_block double_stone_slab stone_slab brick_block tnt bookshelf ' +
	'mossy_cobblestone obsidian torch fire mob_spawner oak_stairs chest redstone_wire diamond_ore diamond_block ' +
	'crafting_table wheat farmland furnace lit_furnace standing_sign wooden_door ladder rail stone_stairs wall_sign lever ' +
	'stone_pressure_plate iron_door wooden_pressure_plate redstone_ore lit_redstone_ore unlit_redstone_torch ' +
	'redstone_torch stone_button snow_layer ice snow cactus clay reeds jukebox fence pumpkin netherrack soul_sand ' +
	'glowstone portal lit_pumpkin cake unpowered_repeater powered_repeater stained_glass trapdoor monster_egg stonebrick ' +
	'brown_mushroom_block red_mushroom_block iron_bars glass_pane melon_block pumpkin_stem melon_stem vine fence_gate ' +
	'brick_stairs stone_brick_stairs mycelium waterlily nether_brick nether_brick_fence nether_brick_stairs nether_wart ' +
	'enchanting_table brewing_stand cauldron end_portal end_portal_frame end_stone dragon_egg redstone_lamp ' +
	'lit_redstone_lamp double_wooden_slab wooden_slab cocoa sandstone_stairs emerald_ore ender_chest tripwire_hook ' +
	'tripwire emerald_block spruce_stairs birch_stairs jungle_stairs command_block beacon cobblestone_wall flower_pot ' +
	'carrots potatoes wooden_button skull anvil trapped_chest light_weighted_pressure_plate ' +
	'heavy_weighted_pressure_plate unpowered_comparator powered_comparator daylight_detector redstone_block quartz_ore ' +
	'hopper quartz_block quartz_stairs activator_rail dropper stained_hardened_clay stained_glass_pane leaves2 log2 ' +
	'acacia_stairs dark_oak_stairs slime barrier iron_trapdoor prismarine sea_lantern hay_block carpet hardened_clay ' +
	'coal_block packed_ice double_plant standing_banner wall_banner daylight_detector_inverted red_sandstone ' +
	'red_sandstone_stairs double_stone_slab2 stone_slab2 spruce_fence_gate birch_fence_gate jungle_fence_gate ' +
	'dark_oak_fence_gate acacia_fence_gate spruce_fence birch_fence jungle_fence dark_oak_fence acacia_fence spruce_door ' +
	'birch_door jungle_door acacia_door dark_oak_door end_rod chorus_plant chorus_flower purpur_block purpur_pillar ' +
	'purpur_stairs purpur_double_slab purpur_slab end_bricks beetroots grass_path end_gateway repeating_command_block ' +
	'chain_command_block frosted_ice magma nether_wart_block red_nether_brick bone_block structure_void observer';
const COLOURS_112 = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'silver', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];

let vanillaTable: Map<number, string> | undefined;
function vanillaBlocks(): Map<number, string> {
	if (!vanillaTable) {
		const names = [
			...VANILLA_BLOCKS.split(' '),
			...COLOURS_112.map((c) => `${c}_shulker_box`),
			...COLOURS_112.map((c) => `${c}_glazed_terracotta`),
			'concrete',
			'concrete_powder'
		];
		vanillaTable = new Map(names.map((n, i) => [i, `minecraft:${n}`]));
		vanillaTable.set(255, 'minecraft:structure_block');
	}
	return vanillaTable;
}

/**
 * A pre-1.13 world's block numbers: Forge's registry in level.dat (1.8-1.12:
 * FML > Registries > minecraft:blocks; 1.7: FML > ItemData, blocks marked
 * \u0001), else vanilla's. Null for 1.13+ worlds, which name their blocks.
 */
const idTables = new Map<string, { stamp: number; ids: Promise<Map<number, string>> }>();

export async function legacyBlockIds(worldDir: string): Promise<Map<number, string>> {
	// Kept while level.dat is unchanged: every region of the map asks.
	const stamp = await fs.stat(path.join(worldDir, 'level.dat')).then((s) => s.mtimeMs, () => 0);
	const hit = idTables.get(worldDir);
	if (hit?.stamp === stamp) return hit.ids;
	const ids = readLegacyBlockIds(worldDir);
	idTables.set(worldDir, { stamp, ids });
	return ids;
}

async function readLegacyBlockIds(worldDir: string): Promise<Map<number, string>> {
	try {
		const level = parseNbt(await fs.readFile(path.join(worldDir, 'level.dat')));
		const fml = child(level.root, 'FML');
		const registry = child(child(child(fml, 'Registries'), 'minecraft:blocks'), 'ids');
		const ids = new Map<number, string>();
		if (registry?.type === 'list') {
			for (const e of registry.value) {
				const key = str(child(e, 'K'));
				const n = num(child(e, 'V'));
				if (key && n !== null) ids.set(n, key);
			}
		} else {
			const data = child(fml, 'ItemData');
			if (data?.type === 'list') {
				for (const e of data.value) {
					const key = str(child(e, 'K'));
					const n = num(child(e, 'V'));
					if (key?.startsWith('\u0001') && n !== null) ids.set(n, key.slice(1));
				}
			}
		}
		if (ids.size) return ids;
	} catch {
		/* no level.dat: vanilla's */
	}
	return vanillaBlocks();
}

// --------------------------------------------------------- top blocks ---

/** The top of one column: the block's key, its height, how deep the water is above whatever is under it. */
type Top = { key: string; y: number; depth: number };

const INVISIBLE = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:barrier', 'minecraft:structure_void', 'minecraft:light']);
const WATERY = new Set(['minecraft:water', 'minecraft:flowing_water', 'minecraft:seagrass', 'minecraft:tall_seagrass', 'minecraft:kelp', 'minecraft:kelp_plant', 'minecraft:bubble_column']);
const isWater = (key: string) => WATERY.has(key.split('@')[0]);

/** A packed long array as 32-bit words, low word first, so bits can be read without BigInt. */
function words(longs: bigint[]): Uint32Array {
	const out = new Uint32Array(longs.length * 2);
	for (let i = 0; i < longs.length; i++) {
		out[i * 2] = Number(longs[i] & 0xffffffffn);
		out[i * 2 + 1] = Number((longs[i] >> 32n) & 0xffffffffn);
	}
	return out;
}

/** 4096 palette indices from packed longs; `spanning` (before 1.16) lets one cross into the next long. */
function unpack(longs: bigint[], bits: number, spanning: boolean): Uint16Array {
	const w = words(longs);
	const out = new Uint16Array(4096);
	const mask = (1 << bits) - 1;
	const perLong = Math.floor(64 / bits);
	for (let i = 0; i < 4096; i++) {
		const bit = spanning ? i * bits : Math.floor(i / perLong) * 64 + (i % perLong) * bits;
		const word = bit >>> 5;
		const off = bit & 31;
		if (word >= w.length) break;
		let v = w[word] >>> off;
		if (off + bits > 32 && word + 1 < w.length) v |= w[word + 1] << (32 - off);
		out[i] = v & mask;
	}
	return out;
}

/** One section's blocks as keys by index (y*256 + z*16 + x), decoded only when a column needs it. */
type Section = { y: number; block: (i: number) => string };

/**
 * A palette entry's block. Up to 1.21: {Name, Properties}. Minecraft 26: a plain
 * string, {id, properties} for a block with properties, and in a list that mixes
 * the two each string wrapped as {"": string} (how NBT lists mix types now).
 */
function propsKey(state: Tag): string {
	if (state.type === 'string') return state.value;
	return str(child(state, 'Name')) ?? str(child(state, 'id')) ?? str(child(state, '')) ?? 'minecraft:air';
}

function modernSection(sec: Tag, spanning: boolean): Section | null {
	const y = num(child(sec, 'Y'));
	const states = child(sec, 'block_states');
	const palette = child(states, 'palette') ?? child(sec, 'Palette');
	const data = child(states, 'data') ?? child(sec, 'BlockStates');
	if (y === null || palette?.type !== 'list' || !palette.value.length) return null;
	const keys = palette.value.map(propsKey);
	if (keys.every((k) => INVISIBLE.has(k))) return null;
	if (keys.length === 1 || data?.type !== 'longArray') return { y, block: () => keys[0] };
	let indices: Uint16Array | undefined;
	const bits = Math.max(4, Math.ceil(Math.log2(keys.length)));
	return {
		y,
		block: (i) => keys[(indices ??= unpack(data.value, bits, spanning))[i]] ?? 'minecraft:air'
	};
}

const nibble = (arr: number[], i: number) => (i & 1 ? (arr[i >> 1] >> 4) & 15 : arr[i >> 1] & 15);

function legacySection(sec: Tag, ids: Map<number, string>): Section | null {
	const y = num(child(sec, 'Y'));
	const blocks = child(sec, 'Blocks');
	const data = child(sec, 'Data');
	const add = child(sec, 'Add');
	const palette = child(sec, 'Palette');
	if (y === null || blocks?.type !== 'byteArray' || blocks.value.length < 4096) return null;
	const b = blocks.value;
	const d = data?.type === 'byteArray' && data.value.length >= 2048 ? data.value : null;
	const a = add?.type === 'byteArray' && add.value.length >= 2048 ? add.value : null;
	const named = (state: number) => {
		const id = state >> 4;
		if (id === 0) return 'minecraft:air';
		return `${ids.get(id) ?? `#${id}`}@${state & 15}`;
	};
	if (palette?.type === 'intArray') {
		// RoughlyEnoughIDs / JEID: the numbers are in the palette, Blocks/Add/Data index it.
		const states = palette.value;
		return { y, block: (i) => named(states[((a ? nibble(a, i) : 0) << 12) | ((b[i] & 255) << 4) | (d ? nibble(d, i) : 0)] ?? 0) };
	}
	return { y, block: (i) => named((((a ? nibble(a, i) : 0) << 8) | (b[i] & 255)) * 16 + (d ? nibble(d, i) : 0)) };
}

/** A chunk's sections, highest first, and what counts as a block to draw; null without block data. */
function chunkSections(root: Tag, legacyIds: Map<number, string> | null): { sections: Section[]; visible: (key: string) => boolean } | null {
	const level = child(root, 'Level');
	const list = child(root, 'sections') ?? child(level, 'Sections');
	if (list?.type !== 'list') return null;
	const version = num(child(root, 'DataVersion')) ?? 0;
	// 1.13 (1451) on name their blocks; before 1.16 (2527) an index can cross two longs.
	const modern = version >= 1451 || list.value.some((s) => child(s, 'block_states') || child(s, 'BlockStates'));
	const sections = list.value
		.map((s) => (modern ? modernSection(s, version < 2527) : legacySection(s, legacyIds ?? vanillaBlocks())))
		.filter((s): s is Section => !!s)
		.sort((a, b) => b.y - a.y);
	const visible = modern ? (k: string) => !INVISIBLE.has(k) : (k: string) => k !== 'minecraft:air';
	return { sections, visible };
}

/** The 256 column tops of one chunk (index z*16 + x); null when it has no block data. */
export function chunkTops(root: Tag, legacyIds: Map<number, string> | null): (Top | null)[] | null {
	const read = chunkSections(root, legacyIds);
	if (!read) return null;
	const { sections, visible } = read;
	const tops: (Top | null)[] = new Array(256).fill(null);
	for (let col = 0; col < 256; col++) {
		let top: Top | null = null;
		search: for (const s of sections) {
			for (let ly = 15; ly >= 0; ly--) {
				const key = s.block(ly * 256 + col);
				if (!top) {
					if (!visible(key)) continue;
					top = { key, y: s.y * 16 + ly, depth: 0 };
					if (!isWater(key)) break search;
				} else if (isWater(key)) {
					top.depth++;
				} else break search;
			}
		}
		tops[col] = top;
	}
	return tops;
}

/** Tuning for the view below a roof; tests and the prototype change it. */
export const roofTuning = {
	/** Share of a region's columns whose first solid block must be at one height for it to count as a roof. */
	share: 0.6,
	/** Open spaces shorter than this (air pockets in the roof's mass) are passed through, not taken as the floor. */
	minGap: 1,
	/** Share of the roof's columns that must have a floor under it: superflat worlds have none. */
	floors: 0.2
};

/**
 * What a column looks like below a roof at `roofY` (the Nether's at 127, a mod's
 * dimension with bedrock top and bottom): down through solid blocks, whatever
 * they are (bedrock, the netherrack under it), to the first open space at least
 * minGap tall, and the first block under it - the floor one walks on. A column
 * with no such space shows the block right under the roof (a wall up to it).
 * Missing sections are air. `floor` says whether an open space was found.
 */
export function chunkUnderRoof(root: Tag, legacyIds: Map<number, string> | null, roofY: number, minGap: number): ({ top: Top; floor: boolean } | null)[] | null {
	const read = chunkSections(root, legacyIds);
	if (!read) return null;
	const { sections, visible } = read;
	const byY = new Map(sections.map((s) => [s.y, s]));
	const lowest = sections.length ? sections[sections.length - 1].y * 16 : 0;
	const at = (col: number, y: number) => {
		const s = byY.get(Math.floor(y / 16));
		return s ? s.block((((y % 16) + 16) % 16) * 256 + col) : 'minecraft:air';
	};
	const out: ({ top: Top; floor: boolean } | null)[] = new Array(256).fill(null);
	for (let col = 0; col < 256; col++) {
		let y = roofY;
		let found: Top | null = null;
		while (y >= lowest && !found) {
			// Through the roof's mass.
			while (y >= lowest && visible(at(col, y))) y--;
			const gapTop = y;
			while (y >= lowest && !visible(at(col, y))) y--;
			if (y < lowest) break;
			if (gapTop - y < minGap) continue;
			const key = at(col, y);
			found = { key, y, depth: 0 };
			if (isWater(key)) {
				for (let d = y - 1; d >= lowest && isWater(at(col, d)); d--) found.depth++;
			}
		}
		if (found) {
			out[col] = { top: found, floor: true };
			continue;
		}
		const under = at(col, roofY - 1);
		if (visible(under)) out[col] = { top: { key: under, y: roofY - 1, depth: 0 }, floor: false };
	}
	return out;
}

// ----------------------------------------------------------- a region ---

export type RegionColumns = {
	/** Block keys, indexed by `blocks` (minus one; 0 = nothing there). */
	keys: string[];
	blocks: Uint16Array;
	heights: Int16Array;
	depths: Uint8Array;
	/** Chunk indices present but not readable (LZ4, damaged): drawn as plain chunks. */
	unreadable: number[];
	/**
	 * Chunks present with nothing to draw, by index: their generation status (without
	 * `minecraft:`; '' when they have none). From 1.18 a ring of chunks generated only
	 * partway (structure_starts, biomes...) surrounds everything loaded, about a third of a
	 * world's chunks: drawn faintly, so the map keeps the shape of what is on disk.
	 */
	bare: Record<number, string>;
	/**
	 * Chunks drawn that are not fully generated yet, by index: their status. Next to
	 * what is loaded, the first rings already have blocks (surface, carvers, features)
	 * but are only finished when a chunk beside them is; pre-generation counts them as
	 * still to do, as Chunky does (it looks for Status full).
	 */
	partial: Record<number, string>;
	/** The height of a roof over the region (the Nether's, a mod dimension's), when it has one. */
	roof: number | null;
	/** With a roof: what is below it, column by column (chunkUnderRoof), drawn instead of the roof. */
	under: Layer | null;
};

/** One picture's columns: block index plus one (0 = nothing), height, water depth. */
type Layer = { blocks: Uint16Array; heights: Int16Array; depths: Uint8Array };

/** A chunk's generation status: Status at the top from 1.18, Level.Status before ('' without one). */
function chunkStatus(root: Tag): string {
	const status = child(root, 'Status') ?? child(child(root, 'Level'), 'Status');
	return status?.type === 'string' ? status.value.replace(/^minecraft:/, '') : '';
}

/** Reads the top of every column of one region file. */
export async function readRegionColumns(dir: string, name: string, legacyIds: Map<number, string> | null): Promise<RegionColumns | null> {
	const region = regionOf(name);
	const file = region ? await fs.readFile(path.join(dir, name)).catch(() => null) : null;
	if (!region || !file || file.length < HEADER) return null;
	const keys: string[] = [];
	const keyIndex = new Map<string, number>();
	const out: RegionColumns = {
		keys,
		blocks: new Uint16Array(AREA),
		heights: new Int16Array(AREA),
		depths: new Uint8Array(AREA),
		unreadable: [],
		bare: {},
		partial: {},
		roof: null,
		under: null
	};
	const put = (layer: Layer, index: number, col: number, top: Top) => {
		let k = keyIndex.get(top.key);
		if (k === undefined) {
			k = keys.length;
			keys.push(top.key);
			keyIndex.set(top.key, k);
		}
		const at = (Math.floor(index / 32) * 16 + (col >> 4)) * SIZE + (index % 32) * 16 + (col & 15);
		layer.blocks[at] = k + 1;
		layer.heights[at] = top.y;
		layer.depths[at] = Math.min(255, top.depth);
	};
	const chunks = locations(file.subarray(0, HEADER));
	// A region is about a second of work on the one thread every request shares: let them in after each chunk.
	const breathe = () => new Promise((resolve) => setImmediate(resolve));
	const parse = async (loc: (typeof chunks)[number]) => {
		const data = await readChunk(dir, file, region, loc);
		return data ? parseNbt(data).root : null;
	};
	for (const loc of chunks) {
		await breathe();
		let tops: (Top | null)[] | null = null;
		let root: Tag | null = null;
		try {
			root = await parse(loc);
			// A chunk generated only partway can have no sections yet: nothing to draw, not unreadable.
			tops = root ? (chunkTops(root, legacyIds) ?? new Array(256).fill(null)) : null;
		} catch {
			tops = null;
		}
		if (!tops || !root) {
			out.unreadable.push(loc.index);
			continue;
		}
		if (tops.every((t) => !t)) {
			out.bare[loc.index] = chunkStatus(root);
			continue;
		}
		for (let col = 0; col < 256; col++) if (tops[col]) put(out, loc.index, col, tops[col]!);
		const status = chunkStatus(root);
		if (status && status !== 'full') out.partial[loc.index] = status;
	}
	// A roof: the view below it takes a second pass, only for regions that have one.
	const roofY = roofHeight(out);
	if (roofY === null) return out;
	const under: Layer = { blocks: new Uint16Array(AREA), heights: new Int16Array(AREA), depths: new Uint8Array(AREA) };
	let columns = 0;
	let floors = 0;
	for (const loc of chunks) {
		if (out.unreadable.includes(loc.index) || loc.index in out.bare) continue;
		await breathe();
		let cols: ReturnType<typeof chunkUnderRoof> = null;
		try {
			const root = await parse(loc);
			cols = root ? chunkUnderRoof(root, legacyIds, roofY, roofTuning.minGap) : null;
		} catch {
			cols = null;
		}
		for (let col = 0; col < 256; col++) {
			const c = cols?.[col];
			if (!c) continue;
			columns++;
			if (c.floor) floors++;
			put(under, loc.index, col, c.top);
		}
	}
	// Solid all the way down (superflat): a flat top, but nothing under it to show.
	if (columns && floors / columns >= roofTuning.floors) {
		out.roof = roofY;
		out.under = under;
	}
	return out;
}

/**
 * The height of a roof over this region, or null: the height most columns' first
 * block is at, when that is at least roofTuning.share of them and not water (an
 * ocean is flat on top too). Anything built on a roof is above it, so it does not count.
 */
function roofHeight(c: RegionColumns): number | null {
	const counts = new Map<number, number>();
	let total = 0;
	const watery = c.keys.map((k) => isWater(k));
	for (let i = 0; i < AREA; i++) {
		const b = c.blocks[i];
		if (!b) continue;
		total++;
		if (!watery[b - 1]) counts.set(c.heights[i], (counts.get(c.heights[i]) ?? 0) + 1);
	}
	let best: number | null = null;
	let most = 0;
	for (const [y, n] of counts) if (n > most) [best, most] = [y, n];
	return best !== null && total && most / total >= roofTuning.share ? best : null;
}

const layerBytes = (l: Layer) => [Buffer.from(l.blocks.buffer), Buffer.from(l.heights.buffer), Buffer.from(l.depths.buffer)];

function encodeColumns(c: RegionColumns): Buffer {
	const head = Buffer.from(JSON.stringify({ v: CACHE_VERSION, keys: c.keys, unreadable: c.unreadable, bare: c.bare, partial: c.partial, roof: c.roof }));
	const len = Buffer.alloc(4);
	len.writeUInt32LE(head.length);
	return Buffer.concat([len, head, ...layerBytes(c), ...(c.under ? layerBytes(c.under) : [])]);
}

function decodeColumns(buf: Buffer): RegionColumns | null {
	try {
		const len = buf.readUInt32LE(0);
		const head = JSON.parse(buf.toString('utf8', 4, 4 + len)) as {
			v: number;
			keys: string[];
			unreadable: number[];
			bare: Record<number, string>;
			partial: Record<number, string>;
			roof: number | null;
		};
		if (head.v !== CACHE_VERSION) return null;
		let at = 4 + len;
		const take = (bytes: number) => {
			const part = new Uint8Array(bytes);
			part.set(buf.subarray(at, at + bytes));
			at += bytes;
			return part.buffer;
		};
		const layer = (): Layer => ({ blocks: new Uint16Array(take(AREA * 2)), heights: new Int16Array(take(AREA * 2)), depths: new Uint8Array(take(AREA)) });
		const top = layer();
		return { keys: head.keys, unreadable: head.unreadable, bare: head.bare, partial: head.partial, roof: head.roof, ...top, under: head.roof !== null ? layer() : null };
	} catch {
		return null;
	}
}

/**
 * Regions read at once, across every map open: the rest wait (a whole world
 * asks for all of them). One: reading is all on the main thread, so a second
 * one adds no speed, only makes every other page wait twice as long.
 */
const READING = 1;
let reading = 0;
const waiting: (() => void)[] = [];

async function inTurn<T>(work: () => Promise<T>): Promise<T> {
	if (reading >= READING) await new Promise<void>((resolve) => waiting.push(resolve));
	reading++;
	try {
		return await work();
	} finally {
		reading--;
		waiting.shift()?.();
	}
}

/**
 * A smaller copy of a region's columns for the zoomed-out map: every
 * `factor`-th column of every `factor`-th row (a map shows one block per
 * pixel, so sampling keeps colours true where averaging would muddy them).
 */
export function shrinkColumns(c: RegionColumns, factor: number): RegionColumns & { size: number } {
	const size = SIZE / factor;
	const shrink = (l: Layer): Layer => {
		const out = { blocks: new Uint16Array(size * size), heights: new Int16Array(size * size), depths: new Uint8Array(size * size) };
		for (let z = 0; z < size; z++) {
			for (let x = 0; x < size; x++) {
				// The middle of each cell: its edges are chunk borders, often the least typical column.
				const from = (z * factor + (factor >> 1)) * SIZE + x * factor + (factor >> 1);
				out.blocks[z * size + x] = l.blocks[from];
				out.heights[z * size + x] = l.heights[from];
				out.depths[z * size + x] = l.depths[from];
			}
		}
		return out;
	};
	return { keys: c.keys, unreadable: c.unreadable, bare: c.bare, partial: c.partial, roof: c.roof, size, ...shrink(c), under: c.under ? shrink(c.under) : null };
}

/**
 * A region's columns, from the disk cache when the file has not changed
 * since (size and time), else read and cached: per server, per folder (the
 * live world and each snapshot apart).
 */
export async function regionColumns(instanceId: string, dir: string, name: string, legacyIds: Map<number, string> | null): Promise<RegionColumns | null> {
	const stat = await fs.stat(path.join(dir, name)).catch(() => null);
	if (!stat) return null;
	const folder = createHash('sha1').update(dir).digest('hex').slice(0, 16);
	const cached = path.join(CACHE, instanceId, folder, `${name}.${stat.size}.${Math.floor(stat.mtimeMs)}.bin.gz`);
	const hit = await fs.readFile(cached).catch(() => null);
	if (hit) {
		const columns = decodeColumns(zlib.gunzipSync(hit));
		if (columns) return columns;
	}
	const columns = await inTurn(() => readRegionColumns(dir, name, legacyIds));
	if (!columns) return null;
	await fs.mkdir(path.dirname(cached), { recursive: true });
	// One cached copy per region file: older ones are stale.
	for (const old of await fs.readdir(path.dirname(cached)).catch(() => [] as string[])) {
		if (old.startsWith(`${name}.`)) await fs.rm(path.join(path.dirname(cached), old), { force: true });
	}
	await fs.writeFile(`${cached}.tmp`, zlib.gzipSync(encodeColumns(columns), { level: 1 }));
	await fs.rename(`${cached}.tmp`, cached);
	return columns;
}

/** Drops a server's cached columns (the server was deleted). */
export async function deleteChunkMapCache(instanceId: string): Promise<void> {
	await fs.rm(path.join(CACHE, instanceId), { recursive: true, force: true });
}

// --------------------------------------------------------------- colours ---

export type BlockInfo = { name: string; color: number | null };

const WATER_TINT = 0x3f76e4;
const looks = new WeakMap<Resources, Map<string, Promise<BlockInfo>>>();

/** The face seen from above: the highest element's up face, else the first face there is, else a flat picture's first layer. */
function topFace(spec: IconSpec | null): { texture: string; tint: string | null } | null {
	if (!spec) return null;
	if (spec.kind === 'flat') return spec.layers[0] ?? null;
	const ups = spec.elements.filter((e) => e.faces.up).sort((a, b) => b.to[1] - a.to[1]);
	const face = ups[0]?.faces.up ?? spec.elements.flatMap((e) => Object.values(e.faces))[0] ?? spec.quads?.[0]?.face;
	return face ? { texture: face.texture, tint: face.tint } : null;
}

async function averageColour(res: Resources, ref: string): Promise<number | null> {
	const [ns, p] = ref.includes(':') ? ref.split(':') : ['minecraft', ref];
	const bytes = await res.read(`${ns}/textures/${p}.png`);
	const png = bytes ? decodePng(bytes) : null;
	if (!png) return null;
	// Animated textures are frames stacked downwards: the first one.
	const h = Math.min(png.height, png.width);
	let r = 0;
	let g = 0;
	let b = 0;
	let weight = 0;
	for (let i = 0; i < png.width * h; i++) {
		const a = png.data[i * 4 + 3];
		if (!a) continue;
		r += png.data[i * 4] * a;
		g += png.data[i * 4 + 1] * a;
		b += png.data[i * 4 + 2] * a;
		weight += a;
	}
	if (!weight) return null;
	return (Math.round(r / weight) << 16) | (Math.round(g / weight) << 8) | Math.round(b / weight);
}

function tinted(colour: number, tint: number): number {
	const c = (shift: number) => Math.round((((colour >> shift) & 255) * ((tint >> shift) & 255)) / 255);
	return (c(16) << 16) | (c(8) << 8) | c(0);
}

/**
 * Blocks renamed since: chunks nobody loaded after the update keep the old
 * name (the game converts a chunk only when it loads it).
 */
const RENAMED: Record<string, string> = { 'minecraft:grass': 'minecraft:short_grass', 'minecraft:grass_path': 'minecraft:dirt_path' };

async function lookUp(res: Resources, key: string, modern: boolean): Promise<BlockInfo> {
	const [id, meta] = key.split('@');
	if (id.startsWith('#')) return { name: `Block ${id.slice(1)}`, color: null };
	let look = await blockLook(res, id, meta === undefined ? null : Number(meta), modern ? {} : null);
	if (!look.spec && modern && RENAMED[id]) look = await blockLook(res, RENAMED[id], null, {});
	const path_ = id.split(':')[1] ?? id;
	// Fluids are drawn in code: their still texture, water tinted (1.13+ textures are grey; 1.12's are blue already).
	if (/^(flowing_)?(water|lava)$/.test(path_)) {
		const fluid = path_.replace('flowing_', '');
		for (const ref of [`minecraft:block/${fluid}_still`, `minecraft:blocks/${fluid}_still`]) {
			const colour = await averageColour(res, ref);
			if (colour !== null) return { name: look.name, color: fluid === 'water' && ref.includes('block/') ? tinted(colour, WATER_TINT) : colour };
		}
		return { name: look.name, color: fluid === 'water' ? WATER_TINT : 0xd96415 };
	}
	const face = topFace(look.spec);
	const colour = face ? await averageColour(res, face.texture) : null;
	if (colour !== null) return { name: look.name, color: face?.tint ? tinted(colour, parseInt(face.tint.slice(1), 16)) : colour };
	const fallback = id.startsWith('minecraft:') ? VANILLA_COLOURS.find(([test]) => test.test(path_))?.[1] : undefined;
	return { name: look.name, color: fallback ?? (await fluidColour(res, id)) };
}

/**
 * Minecraft's commonest surface blocks when its own textures are not there
 * (the server's EULA question unanswered, so no client jar): about their
 * textures' averages, first match wins. The land reads as land; the page
 * says how to get the real colours.
 */
const VANILLA_COLOURS: [RegExp, number][] = [
	[/^cherry_leaves$/, 0xe5adc2],
	[/leaves|^vines?$|^waterlily$|^lily_pad$/, 0x2a650e],
	[/^(grass|grass_block|short_grass|tall_grass|tallgrass|double_plant|fern|large_fern)$/, 0x476d3e],
	[/^red_sand/, 0xbe6621],
	[/sand/, 0xdbcfa3],
	[/^(snow|snow_block|snow_layer|powder_snow)$/, 0xf0fbfb],
	[/ice$/, 0x8db4fa],
	[/^podzol$/, 0x5c3f18],
	[/^mycelium$/, 0x6f6265],
	[/^mud$/, 0x3c393d],
	[/dirt|farmland|grass_path/, 0x866043],
	[/^moss/, 0x596e2d],
	[/^gravel$/, 0x847f7f],
	[/^diorite|^calcite$/, 0xbdbcbd],
	[/^granite/, 0x956756],
	[/deepslate/, 0x505053],
	[/^tuff/, 0x6c6d66],
	[/terracotta|hardened_clay/, 0x985e43],
	[/^clay$/, 0xa1a6b3],
	[/^dark_oak|^big_oak/, 0x42301a],
	[/^spruce/, 0x725430],
	[/^birch/, 0xc0af79],
	[/log|wood|planks|_stem$/, 0x8f7748],
	[/^netherrack$/, 0x622626],
	[/^soul_(sand|soil)$/, 0x513e32],
	[/^end_stone/, 0xdbde9e],
	[/^obsidian$/, 0x0f0a18],
	[/^(sugar_cane|reeds)$/, 0x94c065],
	[/^bamboo/, 0x5e9014],
	[/^cactus$/, 0x557f2b],
	[/stone|cobble|andesite|bedrock|ore$/, 0x7e7e7e]
];

/**
 * A mod's fluid block has no model of its own on 1.12: the mod names its
 * texture in code, mostly after the block (AbyssalCraft's cwater is
 * blocks/cwater_still, BuildCraft's fluid_block_oil_heat_0 is
 * blocks/fluids/oil_heat_0_still). Fluids tinted in code from one shared
 * texture (Tinkers' molten metals) stay without a colour.
 */
async function fluidColour(res: Resources, id: string): Promise<number | null> {
	const [ns, blockPath] = id.includes(':') ? id.split(':') : ['minecraft', id];
	const names = new Set([blockPath, blockPath.replace(/^(fluid_?block|block_?fluid|fluid|block)_?/i, '').replace(/_?(fluid|block)$/i, '')]);
	for (const name of names) {
		const texture = name ? res.fluidTexture(`${ns.toLowerCase()}:${name}`) : null;
		if (!texture) continue;
		const colour = await averageColour(res, texture);
		if (colour !== null) return colour;
	}
	return null;
}

/** Names and colours for block keys; looked up once per set of resources. */
export async function blockInfo(res: Resources, keys: string[], modern: boolean): Promise<Record<string, BlockInfo>> {
	let memo = looks.get(res);
	if (!memo) looks.set(res, (memo = new Map()));
	const out: Record<string, BlockInfo> = {};
	await Promise.all(
		keys.map(async (key) => {
			if (!memo.has(key)) memo.set(key, lookUp(res, key, modern).catch(() => ({ name: key, color: null })));
			out[key] = await memo.get(key)!;
		})
	);
	return out;
}
