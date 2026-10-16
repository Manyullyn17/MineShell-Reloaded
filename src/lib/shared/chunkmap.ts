/**
 * The chunk map in the browser (World > Restore chunks): reading what the
 * chunkmap endpoints send and turning a region into a picture. Drawing,
 * panning and selecting are ChunkMap.svelte's.
 */

export const REGION = 512;
const AREA = REGION * REGION;

export type BlockEntry = { key: string; name: string | null; color: number | null };

export type RegionDetail = {
	blocks: BlockEntry[];
	/** Per column (z * 512 + x): index into `blocks` plus one; 0 = nothing there. */
	ids: Uint16Array;
	heights: Int16Array;
	/** Chunk indices (x + 32 * z) present but unreadable. */
	unreadable: number[];
	/** Minecraft's own textures were there (its EULA answered): vanilla blocks have colours. */
	vanilla: boolean;
	image: ImageData;
};

/** Chunk presence per region, from the overview: 1024 bits by index. */
export function presence(base64: string): Uint8Array {
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	const out = new Uint8Array(1024);
	for (let i = 0; i < 1024; i++) out[i] = (bytes[i >> 3] >> (i & 7)) & 1;
	return out;
}

/** Plain grey for blocks without a picture: the shading still shows the land. */
const UNKNOWN = 0x8c8c8c;
const WATERY = /(^|:)(flowing_)?water(@|$)|seagrass|kelp|bubble_column/;

/** Decodes a region response (see the region endpoint) and draws it. */
export function readRegion(buffer: ArrayBuffer): RegionDetail {
	const view = new DataView(buffer);
	const length = view.getUint32(0, true);
	const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as {
		blocks: BlockEntry[];
		unreadable: number[];
		vanilla: boolean;
	};
	let at = 4 + length;
	const ids = new Uint16Array(buffer, at, AREA);
	at += AREA * 2;
	const heights = new Int16Array(buffer, at, AREA);
	at += AREA * 2;
	const depths = new Uint8Array(buffer, at, AREA);
	const water = head.blocks.map((b) => WATERY.test(b.key));
	const pixels = new Uint8ClampedArray(AREA * 4);
	for (let z = 0; z < REGION; z++) {
		for (let x = 0; x < REGION; x++) {
			const i = z * REGION + x;
			const id = ids[i];
			if (!id) continue;
			const block = head.blocks[id - 1];
			const colour = block?.color ?? UNKNOWN;
			let f: number;
			if (water[id - 1] || depths[i]) {
				// Deeper water is darker, as on a map item.
				f = 1 - Math.min(depths[i], 24) * 0.018;
			} else {
				// Lit from the north: higher than the column north of it is brighter, lower darker.
				const north = z > 0 && ids[i - REGION] ? heights[i - REGION] : heights[i];
				f = 1 + Math.max(-0.22, Math.min(0.14, (heights[i] - north) * 0.06));
			}
			pixels[i * 4] = ((colour >> 16) & 255) * f;
			pixels[i * 4 + 1] = ((colour >> 8) & 255) * f;
			pixels[i * 4 + 2] = (colour & 255) * f;
			pixels[i * 4 + 3] = 255;
		}
	}
	return { blocks: head.blocks, ids, heights, unreadable: head.unreadable, vanilla: head.vanilla, image: new ImageData(pixels, REGION, REGION) };
}

/** The top block at a position inside a region, for the tooltip. */
export function blockAt(detail: RegionDetail, x: number, z: number): { name: string; y: number } | null {
	const i = (((z % REGION) + REGION) % REGION) * REGION + (((x % REGION) + REGION) % REGION);
	const id = detail.ids[i];
	if (!id) return null;
	const block = detail.blocks[id - 1];
	return { name: block.name ?? block.key.split('@')[0], y: detail.heights[i] };
}

export const chunkKey = (cx: number, cz: number) => `${cx},${cz}`;
export const regionFile = (cx: number, cz: number) => `r.${cx >> 5}.${cz >> 5}.mca`;
