import fs from 'node:fs/promises';
import path from 'node:path';
import { child, parseNbt, type Tag } from './nbt';
import {
	assembleRegion,
	chunkCoords,
	DIMENSION_FOLDERS,
	externalName,
	HEADER,
	isExternal,
	locations,
	readChunk,
	REGION_NAME,
	regionOf,
	SECTOR
} from './regionfile';

/**
 * Chunk pruning: deleting chunks that were generated but barely visited, so
 * Minecraft generates them again when someone goes there. Every chunk counts
 * the ticks players spent near it in InhabitedTime (Level.InhabitedTime
 * before 1.18); chunks under a threshold go. That is what pre-generation and
 * flying through leave behind, and most of a world's size.
 *
 * Region files are read through regionfile.ts.
 *
 * A chunk is removed from region/, entities/ and poi/ alike, so old mobs and
 * points of interest do not turn up in the new terrain. Each touched file is
 * rewritten without the removed chunks, which is what frees the space; a file
 * left empty is deleted. A chunk that cannot be read (LZ4, damaged) is kept.
 */

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

/** InhabitedTime of a chunk's NBT, in ticks; null when it has none. */
export function inhabitedTime(root: Tag): number | null {
	const tag = child(root, 'InhabitedTime') ?? child(child(root, 'Level'), 'InhabitedTime');
	if (tag?.type === 'long') return Number(tag.value);
	if (tag?.type === 'int') return tag.value;
	return null;
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
		const region = regionOf(name)!;
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
	const region = regionOf(name)!;
	for (const loc of locations(file.subarray(0, HEADER))) {
		if (!remove.has(loc.index) || !isExternal(file, loc)) continue;
		const [cx, cz] = chunkCoords(region, loc.index);
		await fs.rm(path.join(dir, externalName(cx, cz)), { force: true });
	}
	const rewritten = assembleRegion([file], (index) => (remove.has(index) ? null : 0));
	if (!rewritten) {
		await fs.rm(full, { force: true });
		return;
	}
	await fs.writeFile(`${full}.tmp`, rewritten);
	await fs.rename(`${full}.tmp`, full);
}

/** Removes the planned chunks from region/, entities/ and poi/ under `base`. */
export async function applyPrune(base: string, plan: PrunePlan): Promise<void> {
	for (const folder of DIMENSION_FOLDERS) {
		const dir = path.join(base, folder);
		for (const [name, remove] of plan.files) await rewriteRegion(dir, name, remove);
	}
}
