import { presence, REGION } from './chunkmap';

/**
 * What Chunky would generate for a selection, worked out the way Chunky does
 * (1.2 to 1.5): the shape is first put on chunks, its middle on the middle of
 * the chunk the center is in and its radius to ceil(radius / 16) chunks and a
 * half (ShapeFactory with chunk alignment), then a chunk is in when its
 * middle lies inside, edges included. So a square of radius 500 around 0, 0
 * is chunks -32 to 32 each way: 65 x 65, reaching block 527. A chunk already fully
 * generated (Status full) is left as it is; one generated only partway, as
 * the rings round everything loaded are from 1.18, is finished like a new one.
 */

export type PregenShape = 'square' | 'rectangle' | 'circle' | 'ellipse';

/** Block coordinates; `radiusZ` counts for rectangles and ellipses only. */
export type PregenSelection = { shape: PregenShape; x: number; z: number; radius: number; radiusZ: number };

export const twoRadii = (shape: PregenShape) => shape === 'rectangle' || shape === 'ellipse';
export const isRound = (shape: PregenShape) => shape === 'circle' || shape === 'ellipse';

/** East-west and north-south radius. */
export function radii(sel: PregenSelection): [number, number] {
	return twoRadii(sel.shape) ? [sel.radius, sel.radiusZ] : [sel.radius, sel.radius];
}

/** The shape as Chunky lays it on chunks: middle chunk, and radius in chunks (half a chunk past the last one in). */
function aligned(sel: PregenSelection) {
	const [rx, rz] = radii(sel);
	const [cx, cz] = [Math.trunc(sel.x) >> 4, Math.trunc(sel.z) >> 4];
	const [nx, nz] = [Math.ceil(rx / 16), Math.ceil(rz / 16)];
	return { cx, cz, nx, nz, ax: nx + 0.5, az: nz + 0.5 };
}

/** The shape Chunky tests chunks against, in blocks: for drawing it when chunks are too small to see. */
export function chunkyShape(sel: PregenSelection): { x: number; z: number; rx: number; rz: number } {
	const a = aligned(sel);
	return { x: a.cx * 16 + 8, z: a.cz * 16 + 8, rx: a.ax * 16, rz: a.az * 16 };
}

export function chunkInSelection(sel: PregenSelection, cx: number, cz: number): boolean {
	const a = aligned(sel);
	const [dx, dz] = [cx - a.cx, cz - a.cz];
	if (!(a.nx > 0) || !(a.nz > 0)) return false;
	// Chunky's own sums: a circle by hypot, an ellipse by dx²/rx² + dz²/rz².
	if (sel.shape === 'circle') return Math.hypot(dx, dz) <= a.ax;
	if (sel.shape === 'ellipse') return dx ** 2 / a.ax ** 2 + dz ** 2 / a.az ** 2 <= 1;
	return Math.abs(dx) <= a.nx && Math.abs(dz) <= a.nz;
}

/** The rows of chunks the selection reaches, first and last; null when it is empty. */
export function selectionRows(sel: PregenSelection): [number, number] | null {
	const a = aligned(sel);
	if (!(a.nx > 0) || !(a.nz > 0)) return null;
	return [a.cz - a.nz, a.cz + a.nz];
}

/**
 * The chunks in row cz, first and last (null for none): worked out from the
 * shape's width there, the ends then settled by the test itself (rounding).
 */
export function rowRange(sel: PregenSelection, cz: number): [number, number] | null {
	const a = aligned(sel);
	const dz = cz - a.cz;
	if (!(a.nx > 0) || Math.abs(dz) > a.nz) return null;
	const w = isRound(sel.shape) ? a.ax * Math.sqrt(Math.max(0, 1 - (dz / a.az) ** 2)) : a.nx;
	let lo = a.cx - Math.floor(w) - 1;
	let hi = a.cx + Math.floor(w) + 1;
	while (lo <= hi && !chunkInSelection(sel, lo, cz)) lo++;
	while (hi >= lo && !chunkInSelection(sel, hi, cz)) hi--;
	return lo <= hi ? [lo, hi] : null;
}

/** Every chunk the selection covers, generated or not. A row at a time, so a world-sized circle takes milliseconds. */
export function selectionChunks(sel: PregenSelection): number {
	const rows = selectionRows(sel);
	if (!rows) return 0;
	let total = 0;
	for (let cz = rows[0]; cz <= rows[1]; cz++) {
		const range = rowRange(sel, cz);
		if (range) total += range[1] - range[0] + 1;
	}
	return total;
}

/** What a region's chunk map data says about generation (regionGeneration): chunks not finished, and unreadable ones. */
export type RegionGeneration = { notFull: number[]; unreadable: number[] };

/**
 * The chunks already fully generated inside the selection. A region's chunks
 * are only known once its generation is (`generation`, by "x,z"); until then
 * they count as `unchecked`, and `toCheck` lists those regions. Per region a
 * code per chunk for the map's layer: 1 = fully generated, left as it is.
 * `bytesPerChunk` is what a finished chunk takes on this dimension's disk
 * (region files only), from the regions checked, or all of them while too
 * few are.
 */
export function existingInSelection(
	sel: PregenSelection,
	overview: { x: number; z: number; chunks: string; bytes?: number }[],
	generation: Map<string, RegionGeneration>
): { existing: number; unchecked: number; toCheck: string[]; regions: Map<string, Uint8Array>; bytesPerChunk: number | null; known: number } {
	const shape = chunkyShape(sel);
	const regions = new Map<string, Uint8Array>();
	const toCheck: string[] = [];
	let existing = 0;
	let unchecked = 0;
	const all = { chunks: 0, bytes: 0 };
	const checked = { chunks: 0, bytes: 0 };
	for (const r of overview) {
		const key = `${r.x},${r.z}`;
		const present = presence(r.chunks);
		const gen = generation.get(key);
		const notFull = new Set(gen?.notFull ?? []);
		const count = present.reduce((sum, v) => sum + v, 0);
		all.chunks += count;
		all.bytes += r.bytes ?? 0;
		if (gen) {
			checked.chunks += count - notFull.size;
			checked.bytes += r.bytes ?? 0;
		}
		const [x0, z0] = [r.x * REGION, r.z * REGION];
		if (x0 + REGION < shape.x - shape.rx || x0 > shape.x + shape.rx || z0 + REGION < shape.z - shape.rz || z0 > shape.z + shape.rz) continue;
		let codes: Uint8Array | null = null;
		let inside = 0;
		for (let i = 0; i < 1024; i++) {
			if (!present[i] || !chunkInSelection(sel, r.x * 32 + (i % 32), r.z * 32 + Math.floor(i / 32))) continue;
			inside++;
			if (!gen || notFull.has(i)) continue;
			codes ??= new Uint8Array(1024);
			codes[i] = 1;
			existing++;
		}
		if (codes) regions.set(key, codes);
		if (inside && !gen) {
			unchecked += inside;
			toCheck.push(key);
		}
	}
	const basis = checked.chunks >= 256 ? checked : all;
	return { existing, unchecked, toCheck, regions, bytesPerChunk: basis.chunks && basis.bytes ? basis.bytes / basis.chunks : null, known: basis.chunks };
}
