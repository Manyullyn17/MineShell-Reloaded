import fs from 'node:fs/promises';
import path from 'node:path';
import {
	assembleRegion,
	chunkCoords,
	chunkIndex,
	DIMENSION_FOLDERS,
	externalName,
	isExternal,
	locationMap,
	regionName
} from './regionfile';

/**
 * Putting chosen chunks of a dimension back from a snapshot. Every region
 * file holding a chosen chunk is rebuilt from two: chosen chunks from the
 * snapshot's copy (or gone, when the snapshot had none there, so the game
 * generates them again), every other chunk from the live file, copied as it
 * is. That happens in region/, entities/ and poi/ alike, so the mobs and
 * points of interest match the terrain. Chunks too big for a region file live
 * in their own c.<x>.<z>.mcc: a chosen chunk's live one moves aside, the
 * snapshot's comes in.
 *
 * The plan names files relative to the server folder, as a world change
 * (world.ts) moves and places them; it is made from the files' headers while
 * the server is stopped, so it stays true until the change runs.
 */

export type ChunkRestorePlan = {
	/** Live files that change: moved aside (into a snapshot when wanted). */
	moving: string[];
	/** Files the change puts in place. */
	placing: string[];
	/** Rebuilt region files: path -> how. */
	regions: { rel: string; live: string | null; source: string | null; chosen: Set<number> }[];
	/** .mcc files copied from the snapshot: destination -> source, both relative. */
	externals: { rel: string; source: string }[];
	/** Chosen chunks the snapshot has terrain for, and ones it has not (they go). */
	restored: number;
	removed: number;
};

async function readOrNull(p: string): Promise<Buffer | null> {
	return fs.readFile(p).catch(() => null);
}

/**
 * `base` and `sourceBase` are the dimension's folder (the one holding region/)
 * live and in the snapshot, relative to `root` and `sourceRoot`.
 */
export async function planChunkRestore(
	root: string,
	base: string,
	sourceRoot: string,
	sourceBase: string,
	chunks: [number, number][]
): Promise<ChunkRestorePlan> {
	const byRegion = new Map<string, { region: [number, number]; chosen: Set<number> }>();
	for (const [cx, cz] of chunks) {
		const { region, index } = chunkIndex(cx, cz);
		const name = regionName(region[0], region[1]);
		const entry = byRegion.get(name) ?? byRegion.set(name, { region, chosen: new Set() }).get(name)!;
		entry.chosen.add(index);
	}
	const plan: ChunkRestorePlan = { moving: [], placing: [], regions: [], externals: [], restored: 0, removed: 0 };
	for (const [name, { region, chosen }] of [...byRegion].sort(([a], [b]) => a.localeCompare(b))) {
		for (const folder of DIMENSION_FOLDERS) {
			const rel = path.join(base, folder, name);
			const sourceRel = path.join(sourceBase, folder, name);
			const live = await readOrNull(path.join(root, rel));
			const source = await readOrNull(path.join(sourceRoot, sourceRel));
			if (!live && !source) continue;
			const liveAt = locationMap(live);
			const sourceAt = locationMap(source);
			// Nothing chosen is in either file: this one stays as it is.
			if (![...chosen].some((i) => liveAt.has(i) || sourceAt.has(i))) continue;
			if (live) plan.moving.push(rel);
			const left = [...Array(1024).keys()].some((i) => (chosen.has(i) ? sourceAt.has(i) : liveAt.has(i)));
			if (left) plan.placing.push(rel);
			plan.regions.push({ rel, live: live ? rel : null, source: source ? sourceRel : null, chosen });
			for (const index of chosen) {
				const [cx, cz] = chunkCoords(region, index);
				const mcc = path.join(base, folder, externalName(cx, cz));
				const liveLoc = liveAt.get(index);
				const sourceLoc = sourceAt.get(index);
				if (live && liveLoc && isExternal(live, liveLoc)) plan.moving.push(mcc);
				if (source && sourceLoc && isExternal(source, sourceLoc)) {
					plan.placing.push(mcc);
					plan.externals.push({ rel: mcc, source: path.join(sourceBase, folder, externalName(cx, cz)) });
				}
				if (folder === 'region') {
					if (sourceLoc) plan.restored++;
					else if (liveLoc) plan.removed++;
				}
			}
		}
	}
	return plan;
}

/** Writes the plan's files under `incoming` (relative paths as in the plan). */
export async function assembleChunkRestore(
	root: string,
	sourceRoot: string,
	incoming: string,
	plan: ChunkRestorePlan
): Promise<void> {
	for (const r of plan.regions) {
		const live = r.live ? await fs.readFile(path.join(root, r.live)) : null;
		const source = r.source ? await fs.readFile(path.join(sourceRoot, r.source)) : null;
		const rebuilt = assembleRegion([live, source], (index) => (r.chosen.has(index) ? 1 : 0));
		if (!rebuilt) continue;
		await fs.mkdir(path.dirname(path.join(incoming, r.rel)), { recursive: true });
		await fs.writeFile(path.join(incoming, r.rel), rebuilt);
	}
	for (const e of plan.externals) {
		await fs.mkdir(path.dirname(path.join(incoming, e.rel)), { recursive: true });
		await fs.copyFile(path.join(sourceRoot, e.source), path.join(incoming, e.rel));
	}
}
