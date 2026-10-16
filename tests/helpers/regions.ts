import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { inhabitedTime } from '#lib/server/chunkprune.js';
import { parseNbt, writeNbt, type Tag } from '#lib/server/nbt.js';

/**
 * Region files in Minecraft's format for tests. A chunk carries only its
 * InhabitedTime (and padding to make it big), which doubles as a marker of
 * which file a chunk came from.
 */

const SECTOR = 4096;

export type ChunkSpec = { index: number; ticks?: number; legacy?: boolean; compression?: number; external?: boolean; pad?: number };

/** A chunk's NBT: 1.18+ keeps InhabitedTime at the top, 1.12-1.17 under Level. */
function chunkNbt(spec: ChunkSpec): Buffer {
	const fields: [string, Tag][] = [
		['InhabitedTime', { type: 'long', value: BigInt(spec.ticks ?? 0) }],
		['Padding', { type: 'byteArray', value: new Array(spec.pad ?? 0).fill(1) }]
	];
	const root: Tag = spec.legacy
		? { type: 'compound', value: [['Level', { type: 'compound', value: fields }]] }
		: { type: 'compound', value: [['DataVersion', { type: 'int', value: 3955 }], ...fields] };
	return writeNbt({ name: '', gzipped: false, root: root as Extract<Tag, { type: 'compound' }> });
}

/** Writes r.<rx>.<rz>.mca in Minecraft's format; an `external` chunk goes to c.<x>.<z>.mcc. */
export async function writeRegion(dir: string, rx: number, rz: number, chunks: ChunkSpec[]): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	const header = Buffer.alloc(2 * SECTOR);
	const bodies: Buffer[] = [];
	let next = 2;
	for (const spec of chunks) {
		const compression = spec.compression ?? 2;
		const data = compression === 2 ? zlib.deflateSync(chunkNbt(spec)) : chunkNbt(spec);
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

/** InhabitedTime of every chunk still in a region file, by index; external chunks are read from their .mcc. */
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
		found[index] = inhabitedTime(parseNbt(zlib.inflateSync(data)).root)!;
	}
	return found;
}
