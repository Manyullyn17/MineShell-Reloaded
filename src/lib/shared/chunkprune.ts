/**
 * Chunk pruning's rules, shared by the map that previews it (World > Prune
 * chunks) and the server that prunes: which chunks go under a threshold and
 * spawn radius, the heatmap's steps, and the analysis the map is drawn from.
 */

/** Ticks per value in an analysis: a chunk that was never there, or one that could not be read (kept). */
export const NO_CHUNK = 0xffffffff;
export const UNREADABLE = 0xfffffffe;

export type PruneRule = {
	/** Chunks visited for fewer ticks than this go (20 ticks a second). */
	maxTicks: number;
	/** Kept regardless, in block coordinates: everything within `radius` of the center. */
	keep: { x: number; z: number; radius: number } | null;
};

/** Whether the spawn radius keeps a chunk: any part of it within the radius. */
export function keptBySpawn(keep: PruneRule['keep'], cx: number, cz: number): boolean {
	if (!keep || keep.radius <= 0) return false;
	const nearestX = Math.max(cx * 16, Math.min(keep.x, cx * 16 + 15));
	const nearestZ = Math.max(cz * 16, Math.min(keep.z, cz * 16 + 15));
	return (nearestX - keep.x) ** 2 + (nearestZ - keep.z) ** 2 <= keep.radius ** 2;
}

/** Whether a chunk with this InhabitedTime goes; null (unreadable) never does. */
export function prunes(ticks: number | null, cx: number, cz: number, rule: PruneRule): boolean {
	return ticks !== null && ticks < rule.maxTicks && !keptBySpawn(rule.keep, cx, cz);
}

/** The thresholds offered, which are also the heatmap's steps. */
export const PRUNE_TICKS = [
	{ ticks: 1, label: 'never (0 seconds)' },
	{ ticks: 100, label: '5 seconds' },
	{ ticks: 1200, label: '1 minute' },
	{ ticks: 6000, label: '5 minutes' },
	{ ticks: 36000, label: '30 minutes' },
	{ ticks: 144000, label: '2 hours' }
];

/**
 * The heatmap's steps by time spent, lowest first: step n holds chunks under
 * `below` ticks and at least the step before's. Colours are `--heat-<n>`.
 */
export const HEAT_STEPS = [
	{ below: 1, label: 'Never' },
	{ below: 1200, label: 'Under 1 min' },
	{ below: 6000, label: '1-5 min' },
	{ below: 36000, label: '5-30 min' },
	{ below: 144000, label: '30 min-2 h' },
	{ below: 720000, label: '2-10 h' },
	{ below: Infinity, label: '10 h or more' }
];

/** Heat step of a chunk, from 1. */
export function heatStep(ticks: number): number {
	return HEAT_STEPS.findIndex((s) => ticks < s.below) + 1;
}

/** Time spent in a chunk, for the map's tooltip. */
export function formatTicks(ticks: number): string {
	const seconds = Math.floor(ticks / 20);
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
	const hours = Math.floor(minutes / 60);
	return `${hours} h ${minutes % 60} min`;
}

/** One region of an analysis: per chunk index (x + 32 * z), its InhabitedTime and the sectors it takes. */
export type AnalysedRegion = { x: number; z: number; ticks: Uint32Array; sectors: Uint16Array };

export type AnalysisHead = {
	dimension: string;
	at: number;
	/** The world spawn when analysed (overworld only), for the radius kept around it. */
	spawn: { x: number; z: number } | null;
	regions: { x: number; z: number }[];
};

/**
 * The analysis endpoint's body: a little-endian u32 length, that much JSON
 * (AnalysisHead, padded to 4 bytes), then every region's 1024 ticks (u32),
 * then every region's 1024 sector counts (u16), in the head's region order.
 */
export function encodeAnalysis(head: AnalysisHead, regions: AnalysedRegion[]): Uint8Array {
	let json = JSON.stringify(head);
	const bytes = new TextEncoder().encode(json);
	const padded = Math.ceil(bytes.length / 4) * 4;
	json += ' '.repeat(padded - bytes.length);
	const out = new Uint8Array(4 + padded + regions.length * 1024 * 6);
	new DataView(out.buffer).setUint32(0, padded, true);
	out.set(new TextEncoder().encode(json), 4);
	let at = 4 + padded;
	for (const r of regions) {
		out.set(new Uint8Array(r.ticks.buffer, r.ticks.byteOffset, 4096), at);
		at += 4096;
	}
	for (const r of regions) {
		out.set(new Uint8Array(r.sectors.buffer, r.sectors.byteOffset, 2048), at);
		at += 2048;
	}
	return out;
}

export function decodeAnalysis(buffer: ArrayBuffer): { head: AnalysisHead; regions: AnalysedRegion[] } {
	const length = new DataView(buffer).getUint32(0, true);
	const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as AnalysisHead;
	const start = 4 + length;
	const count = head.regions.length;
	const regions = head.regions.map((r, i) => ({
		...r,
		ticks: new Uint32Array(buffer.slice(start + i * 4096, start + (i + 1) * 4096)),
		sectors: new Uint16Array(buffer.slice(start + count * 4096 + i * 2048, start + count * 4096 + (i + 1) * 2048))
	}));
	return { head, regions };
}
