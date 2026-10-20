import { presence, REGION } from './chunkmap';

/**
 * What Chunky would generate for a selection, worked out the way Chunky does
 * (1.2 to 1.5): a chunk is in when the middle of it, block (cx * 16 + 8,
 * cz * 16 + 8), lies inside the shape, edges included. Chunks that exist are
 * skipped, so the map's overview tells how many are new.
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

/** Whether block (bx, bz) lies inside, with Chunky's own sums (a circle by hypot, an ellipse by dx²/rx² + dz²/rz²). */
function inside(sel: PregenSelection, bx: number, bz: number): boolean {
	const [rx, rz] = radii(sel);
	const [dx, dz] = [bx - sel.x, bz - sel.z];
	if (sel.shape === 'circle') return Math.hypot(dx, dz) <= rx;
	if (sel.shape === 'ellipse') return dx ** 2 / rx ** 2 + dz ** 2 / rz ** 2 <= 1;
	return Math.abs(dx) <= rx && Math.abs(dz) <= rz;
}

export function chunkInSelection(sel: PregenSelection, cx: number, cz: number): boolean {
	return inside(sel, cx * 16 + 8, cz * 16 + 8);
}

/** Chunks in row cz: worked out from the shape's width there, its ends then settled by the test itself (rounding). */
function rowCount(sel: PregenSelection, cz: number): number {
	const [rx, rz] = radii(sel);
	const dz = cz * 16 + 8 - sel.z;
	if (Math.abs(dz) > rz) return 0;
	const w = isRound(sel.shape) ? rx * Math.sqrt(Math.max(0, 1 - (dz / rz) ** 2)) : rx;
	let lo = Math.ceil((sel.x - w - 8) / 16) - 1;
	let hi = Math.floor((sel.x + w - 8) / 16) + 1;
	while (lo <= hi && !chunkInSelection(sel, lo, cz)) lo++;
	while (hi >= lo && !chunkInSelection(sel, hi, cz)) hi--;
	return hi - lo + 1;
}

/** Every chunk the selection covers, generated or not. A row at a time, so a world-sized circle takes milliseconds. */
export function selectionChunks(sel: PregenSelection): number {
	const [, rz] = radii(sel);
	if (!(sel.radius > 0) || !(rz > 0)) return 0;
	let total = 0;
	for (let cz = Math.ceil((sel.z - rz - 8) / 16); cz <= Math.floor((sel.z + rz - 8) / 16); cz++) {
		total += rowCount(sel, cz);
	}
	return total;
}

/**
 * The chunks that already exist inside the selection, from the chunk map's
 * overview: how many, and per region a code per chunk (1 = there, skipped)
 * for the map's layer. `bytesPerChunk` is what a chunk takes on this
 * dimension's disk so far (region files only), for the estimate.
 */
export function existingInSelection(
	sel: PregenSelection,
	overview: { x: number; z: number; chunks: string; bytes?: number }[]
): { existing: number; regions: Map<string, Uint8Array>; bytesPerChunk: number | null; known: number } {
	const [rx, rz] = radii(sel);
	const regions = new Map<string, Uint8Array>();
	let existing = 0;
	let known = 0;
	let bytes = 0;
	for (const r of overview) {
		const present = presence(r.chunks);
		const count = present.reduce((sum, v) => sum + v, 0);
		known += count;
		bytes += r.bytes ?? 0;
		const [x0, z0] = [r.x * REGION, r.z * REGION];
		if (x0 + REGION < sel.x - rx || x0 > sel.x + rx || z0 + REGION < sel.z - rz || z0 > sel.z + rz) continue;
		let codes: Uint8Array | null = null;
		for (let i = 0; i < 1024; i++) {
			if (!present[i] || !chunkInSelection(sel, r.x * 32 + (i % 32), r.z * 32 + Math.floor(i / 32))) continue;
			codes ??= new Uint8Array(1024);
			codes[i] = 1;
			existing++;
		}
		if (codes) regions.set(`${r.x},${r.z}`, codes);
	}
	return { existing, regions, bytesPerChunk: known && bytes ? bytes / known : null, known };
}
