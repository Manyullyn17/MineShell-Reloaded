import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { child, parseNbt, type Tag } from './nbt';

/**
 * Chunk pruning: deleting chunks that were generated but barely visited, so
 * Minecraft generates them again when someone goes there. Every chunk counts
 * the ticks players spent near it in InhabitedTime (Level.InhabitedTime
 * before 1.18); chunks under a threshold go. That is what pre-generation and
 * flying through leave behind, and most of a world's size.
 *
 * Region files (.mca): an 8 KiB header - 1024 four-byte locations (offset in
 * 4 KiB sectors: 3 bytes, sector count: 1 byte) and 1024 timestamps - then
 * each chunk as length (4 bytes), compression (1 byte: 1 gzip, 2 zlib,
 * 3 none, 4 LZ4; +128 when the data is in c.<x>.<z>.mcc beside the file),
 * data. A chunk is index x + 32 * z within its 32x32 region.
 *
 * A chunk is removed from region/, entities/ and poi/ alike, so old mobs and
 * points of interest do not turn up in the new terrain. Each touched file is
 * rewritten without the removed chunks, which is what frees the space; a file
 * left empty is deleted. A chunk that cannot be read (LZ4, damaged) is kept.
 */

const SECTOR = 4096;
const HEADER = 2 * SECTOR;
const EXTERNAL = 128;
const REGION_NAME = /^r\.(-?\d+)\.(-?\d+)\.mca$/;
export const DIMENSION_FOLDERS = ['region', 'entities', 'poi'];

export type PruneOptions = {
	/** Chunks with InhabitedTime below this many ticks go (20 ticks a second). */
	maxTicks: number;
	/** Kept regardless, in block coordinates: everything within `radius` of the center. */
	keep: { x: number; z: number; radius: number } | null;
};

export type PrunePlan = {
	/** Region file name -> chunk indices to remove. */
	files: Map<string, Set<number>>;
	chunks: number;
	remove: number;
	/** Chunks that could not be read, and are kept. */
	unreadable: number;
	/** Sectors the removed chunks take in region/ (entities/ and poi/ free more). */
	bytes: number;
};

type Location = { index: number; offset: number; sectors: number };

function locations(header: Buffer): Location[] {
	const found: Location[] = [];
	for (let index = 0; index < 1024; index++) {
		const entry = header.readUInt32BE(index * 4);
		const offset = entry >>> 8;
		const sectors = entry & 0xff;
		if (offset >= 2 && sectors > 0) found.push({ index, offset, sectors });
	}
	return found;
}

function decompress(type: number, data: Buffer): Buffer | null {
	try {
		if (type === 1) return zlib.gunzipSync(data);
		if (type === 2) return zlib.inflateSync(data);
		if (type === 3) return data;
	} catch {
		/* damaged: kept */
	}
	return null;
}

/** InhabitedTime of a chunk's NBT, in ticks; null when it has none. */
export function inhabitedTime(root: Tag): number | null {
	const tag = child(root, 'InhabitedTime') ?? child(child(root, 'Level'), 'InhabitedTime');
	if (tag?.type === 'long') return Number(tag.value);
	if (tag?.type === 'int') return tag.value;
	return null;
}

async function readChunk(dir: string, file: Buffer, region: [number, number], loc: Location): Promise<Buffer | null> {
	const start = loc.offset * SECTOR;
	if (start + 5 > file.length) return null;
	const length = file.readUInt32BE(start);
	const type = file[start + 4];
	if (type & EXTERNAL) {
		const [cx, cz] = chunkCoords(region, loc.index);
		const external = await fs.readFile(path.join(dir, `c.${cx}.${cz}.mcc`)).catch(() => null);
		return external ? decompress(type & ~EXTERNAL, external) : null;
	}
	if (length < 1 || start + 4 + length > file.length) return null;
	return decompress(type, file.subarray(start + 5, start + 4 + length));
}

function chunkCoords(region: [number, number], index: number): [number, number] {
	return [region[0] * 32 + (index % 32), region[1] * 32 + Math.floor(index / 32)];
}

function kept(keep: PruneOptions['keep'], cx: number, cz: number): boolean {
	if (!keep || keep.radius <= 0) return false;
	// Any part of the chunk within the radius keeps it.
	const nearestX = Math.max(cx * 16, Math.min(keep.x, cx * 16 + 15));
	const nearestZ = Math.max(cz * 16, Math.min(keep.z, cz * 16 + 15));
	return (nearestX - keep.x) ** 2 + (nearestZ - keep.z) ** 2 <= keep.radius ** 2;
}

/**
 * Which chunks of a dimension go. `base` holds its region/ folder (the world
 * folder for the overworld, DIM-1 for the nether, ...).
 */
export async function planPrune(
	base: string,
	opts: PruneOptions,
	progress?: (done: number, total: number) => void
): Promise<PrunePlan> {
	const dir = path.join(base, 'region');
	const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => REGION_NAME.test(n)).sort();
	const plan: PrunePlan = { files: new Map(), chunks: 0, remove: 0, unreadable: 0, bytes: 0 };
	for (const [i, name] of names.entries()) {
		progress?.(i, names.length);
		const m = name.match(REGION_NAME)!;
		const region: [number, number] = [Number(m[1]), Number(m[2])];
		const file = await fs.readFile(path.join(dir, name));
		if (file.length < HEADER) continue;
		const remove = new Set<number>();
		for (const loc of locations(file.subarray(0, HEADER))) {
			plan.chunks++;
			const [cx, cz] = chunkCoords(region, loc.index);
			if (kept(opts.keep, cx, cz)) continue;
			const data = await readChunk(dir, file, region, loc);
			let ticks: number | null = null;
			try {
				ticks = data ? inhabitedTime(parseNbt(data).root) : null;
			} catch {
				ticks = null;
			}
			if (ticks === null) {
				plan.unreadable++;
				continue;
			}
			if (ticks < opts.maxTicks) {
				remove.add(loc.index);
				plan.bytes += loc.sectors * SECTOR;
			}
		}
		if (remove.size) {
			plan.files.set(name, remove);
			plan.remove += remove.size;
		}
	}
	progress?.(names.length, names.length);
	return plan;
}

/**
 * Rewrites one region file without the given chunks, packing the rest from
 * sector 2 on; deletes it when nothing is left. Removed chunks' external
 * .mcc files go too.
 */
async function rewriteRegion(dir: string, name: string, remove: Set<number>): Promise<void> {
	const full = path.join(dir, name);
	const file = await fs.readFile(full).catch(() => null);
	if (!file || file.length < HEADER) return;
	const m = name.match(REGION_NAME)!;
	const region: [number, number] = [Number(m[1]), Number(m[2])];
	const header = Buffer.alloc(HEADER);
	const bodies: Buffer[] = [];
	let next = 2;
	for (const loc of locations(file.subarray(0, HEADER))) {
		if (remove.has(loc.index)) {
			const start = loc.offset * SECTOR;
			if (start + 5 <= file.length && file[start + 4] & EXTERNAL) {
				const [cx, cz] = chunkCoords(region, loc.index);
				await fs.rm(path.join(dir, `c.${cx}.${cz}.mcc`), { force: true });
			}
			continue;
		}
		const body = Buffer.alloc(loc.sectors * SECTOR);
		file.copy(body, 0, loc.offset * SECTOR, Math.min(file.length, (loc.offset + loc.sectors) * SECTOR));
		header.writeUInt32BE(((next << 8) | loc.sectors) >>> 0, loc.index * 4);
		header.writeUInt32BE(file.readUInt32BE(SECTOR + loc.index * 4), SECTOR + loc.index * 4);
		bodies.push(body);
		next += loc.sectors;
	}
	if (!bodies.length) {
		await fs.rm(full, { force: true });
		return;
	}
	await fs.writeFile(`${full}.tmp`, Buffer.concat([header, ...bodies]));
	await fs.rename(`${full}.tmp`, full);
}

/** Removes the planned chunks from region/, entities/ and poi/ under `base`. */
export async function applyPrune(base: string, plan: PrunePlan): Promise<void> {
	for (const folder of DIMENSION_FOLDERS) {
		const dir = path.join(base, folder);
		for (const [name, remove] of plan.files) await rewriteRegion(dir, name, remove);
	}
}
