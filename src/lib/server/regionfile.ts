import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { NBT_MAX_BYTES } from './nbt';

/**
 * Region files (.mca), shared by chunk pruning, chunk restore and the chunk
 * map: an 8 KiB header - 1024 four-byte locations (offset in 4 KiB sectors:
 * 3 bytes, sector count: 1 byte) and 1024 timestamps - then each chunk as
 * length (4 bytes), compression (1 byte: 1 gzip, 2 zlib, 3 none, 4 LZ4; +128
 * when the data is in c.<x>.<z>.mcc beside the file), data. A chunk is index
 * x + 32 * z within its 32x32 region.
 */

export const SECTOR = 4096;
export const HEADER = 2 * SECTOR;
export const EXTERNAL = 128;
export const REGION_NAME = /^r\.(-?\d+)\.(-?\d+)\.mca$/;
/** A dimension's folders that hold region files: terrain, entities (1.17+), points of interest (1.14+). */
export const DIMENSION_FOLDERS = ['region', 'entities', 'poi'];

export type Location = { index: number; offset: number; sectors: number };

export function locations(header: Buffer): Location[] {
	const found: Location[] = [];
	for (let index = 0; index < 1024; index++) {
		const entry = header.readUInt32BE(index * 4);
		const offset = entry >>> 8;
		const sectors = entry & 0xff;
		if (offset >= 2 && sectors > 0) found.push({ index, offset, sectors });
	}
	return found;
}

/** `r.-1.2.mca` -> [-1, 2]; null for anything else. */
export function regionOf(name: string): [number, number] | null {
	const m = name.match(REGION_NAME);
	return m ? [Number(m[1]), Number(m[2])] : null;
}

export const regionName = (rx: number, rz: number) => `r.${rx}.${rz}.mca`;

export function chunkCoords(region: [number, number], index: number): [number, number] {
	return [region[0] * 32 + (index % 32), region[1] * 32 + Math.floor(index / 32)];
}

/** A chunk's region and its index there. */
export function chunkIndex(cx: number, cz: number): { region: [number, number]; index: number } {
	return { region: [cx >> 5, cz >> 5], index: (cx & 31) + 32 * (cz & 31) };
}

export const externalName = (cx: number, cz: number) => `c.${cx}.${cz}.mcc`;

/** Whether a chunk's data is in its own .mcc file beside the region file. */
export function isExternal(file: Buffer, loc: Location): boolean {
	const start = loc.offset * SECTOR;
	return start + 5 <= file.length && (file[start + 4] & EXTERNAL) !== 0;
}

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);

/**
 * Over NBT_MAX_BYTES unpacked, a chunk is unreadable (pruning keeps those): an
 * .mcc beside the region can be any size. On zlib's thread pool, not the one
 * thread every request shares: unpacking was most of a prune analysis (18.6 s
 * for MeatballCraft's 499 regions), and callers can unpack several at once.
 */
async function decompress(type: number, data: Buffer): Promise<Buffer | null> {
	try {
		if (type === 1) return await gunzip(data, { maxOutputLength: NBT_MAX_BYTES });
		if (type === 2) return await inflate(data, { maxOutputLength: NBT_MAX_BYTES });
		if (type === 3) return data.length <= NBT_MAX_BYTES ? data : null;
	} catch {
		/* damaged */
	}
	return null;
}

/** A chunk's NBT bytes; null when it cannot be read (LZ4, damaged, its .mcc missing). */
export async function readChunk(dir: string, file: Buffer, region: [number, number], loc: Location): Promise<Buffer | null> {
	const start = loc.offset * SECTOR;
	if (start + 5 > file.length) return null;
	const length = file.readUInt32BE(start);
	const type = file[start + 4];
	if (type & EXTERNAL) {
		const [cx, cz] = chunkCoords(region, loc.index);
		const external = await fs.readFile(path.join(dir, externalName(cx, cz))).catch(() => null);
		return external ? decompress(type & ~EXTERNAL, external) : null;
	}
	if (length < 1 || start + 4 + length > file.length) return null;
	return decompress(type, file.subarray(start + 5, start + 4 + length));
}

/** The chunks a region file holds, as a 1024-entry presence list (by index). */
export function presentChunks(file: Buffer): Uint8Array {
	const present = new Uint8Array(1024);
	if (file.length < HEADER) return present;
	for (const loc of locations(file.subarray(0, HEADER))) present[loc.index] = 1;
	return present;
}

/**
 * A region file put together from chunks: for each index, `pick` says which
 * of the given files it comes from (or none). Chunks are copied as they are,
 * sectors and timestamp, never decoded, so LZ4 and damaged ones travel too.
 * Null when no chunk is left.
 */
export function assembleRegion(files: (Buffer | null)[], pick: (index: number) => number | null): Buffer | null {
	const header = Buffer.alloc(HEADER);
	const bodies: Buffer[] = [];
	const located = files.map((f) => {
		const byIndex = new Map<number, Location>();
		if (f && f.length >= HEADER) for (const loc of locations(f.subarray(0, HEADER))) byIndex.set(loc.index, loc);
		return byIndex;
	});
	let next = 2;
	for (let index = 0; index < 1024; index++) {
		const from = pick(index);
		const file = from === null ? null : files[from];
		const loc = from === null ? undefined : located[from].get(index);
		if (!file || !loc) continue;
		const body = Buffer.alloc(loc.sectors * SECTOR);
		file.copy(body, 0, loc.offset * SECTOR, Math.min(file.length, (loc.offset + loc.sectors) * SECTOR));
		header.writeUInt32BE(((next << 8) | loc.sectors) >>> 0, index * 4);
		header.writeUInt32BE(file.readUInt32BE(SECTOR + index * 4), SECTOR + index * 4);
		bodies.push(body);
		next += loc.sectors;
	}
	return bodies.length ? Buffer.concat([header, ...bodies]) : null;
}

/** Which chunk indices a region file holds, by index -> location. */
export function locationMap(file: Buffer | null): Map<number, Location> {
	const map = new Map<number, Location>();
	if (file && file.length >= HEADER) for (const loc of locations(file.subarray(0, HEADER))) map.set(loc.index, loc);
	return map;
}
