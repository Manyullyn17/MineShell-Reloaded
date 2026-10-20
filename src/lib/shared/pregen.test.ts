import { describe, expect, it } from 'vitest';
import { chunkInSelection, existingInSelection, selectionChunks, type PregenSelection } from './pregen';

const sel = (s: Partial<PregenSelection>): PregenSelection => ({ shape: 'square', x: 0, z: 0, radius: 100, radiusZ: 100, ...s });

/** Chunky's own way, chunk by chunk: its iterator's square around the middle chunk, then the shape's test on each chunk's middle. */
function chunkyCount(s: PregenSelection): number {
	const [rx, rz] = s.shape === 'rectangle' || s.shape === 'ellipse' ? [s.radius, s.radiusZ] : [s.radius, s.radius];
	const [ccx, ccz] = [Math.trunc(s.x) >> 4, Math.trunc(s.z) >> 4];
	const [rcx, rcz] = [Math.ceil(rx / 16), Math.ceil(rz / 16)];
	let n = 0;
	for (let cz = ccz - rcz; cz <= ccz + rcz; cz++) {
		for (let cx = ccx - rcx; cx <= ccx + rcx; cx++) {
			const [dx, dz] = [cx * 16 + 8 - s.x, cz * 16 + 8 - s.z];
			const inside =
				s.shape === 'circle'
					? Math.hypot(dx, dz) <= rx
					: s.shape === 'ellipse'
						? (dx / rx) ** 2 + (dz / rz) ** 2 <= 1
						: Math.abs(dx) <= rx && Math.abs(dz) <= rz;
			if (inside) n++;
		}
	}
	return n;
}

describe('pre-generation selections', () => {
	it('count the chunks Chunky would go through, for every shape and off-grid centers', () => {
		for (const s of [
			sel({}),
			sel({ radius: 2500 }),
			sel({ shape: 'circle', radius: 2500, x: 37, z: -1203 }),
			sel({ shape: 'rectangle', radius: 3000, radiusZ: 700, x: -5000, z: 12 }),
			sel({ shape: 'ellipse', radius: 400, radiusZ: 1900, x: 8, z: 8 }),
			sel({ shape: 'circle', radius: 16, x: -1, z: -1 })
		]) {
			expect(selectionChunks(s), JSON.stringify(s)).toBe(chunkyCount(s));
		}
	});

	it('tell a chunk inside from one outside by its middle', () => {
		// Radius 100 around 0: chunk 5 (blocks 80-95, middle 88) is in, chunk 6 (middle 104) out.
		expect(chunkInSelection(sel({}), 5, 0)).toBe(true);
		expect(chunkInSelection(sel({}), 6, 0)).toBe(false);
		expect(chunkInSelection(sel({}), -7, 0)).toBe(false);
		expect(chunkInSelection(sel({ shape: 'circle' }), 5, 5)).toBe(false);
	});

	it('find the chunks already there inside the selection, and what one takes on disk', () => {
		// Region 0,0 with chunks 0,0 and 31,31; region 5,5 far away with one chunk.
		const bits = new Uint8Array(128);
		bits[0] = 1;
		bits[127] = 0x80;
		const far = new Uint8Array(128);
		far[0] = 1;
		const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
		const overview = [
			{ x: 0, z: 0, chunks: b64(bits), bytes: 3 * 4096 },
			{ x: 5, z: 5, chunks: b64(far), bytes: 3 * 4096 }
		];
		const result = existingInSelection(sel({ radius: 64 }), overview);
		expect(result.existing).toBe(1);
		expect([...result.regions.keys()]).toEqual(['0,0']);
		expect(result.regions.get('0,0')![0]).toBe(1);
		expect(result.bytesPerChunk).toBe(2 * 4096);
		expect(result.known).toBe(3);
	});
});
