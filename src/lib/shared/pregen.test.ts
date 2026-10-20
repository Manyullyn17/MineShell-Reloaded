import { describe, expect, it } from 'vitest';
import { chunkInSelection, existingInSelection, rowRange, selectionChunks, selectionRows, type PregenSelection } from './pregen';

const sel = (s: Partial<PregenSelection>): PregenSelection => ({ shape: 'square', x: 0, z: 0, radius: 100, radiusZ: 100, ...s });

/**
 * Chunky's own way, chunk by chunk (GenerationTask, ShapeFactory with chunk alignment): its
 * iterator's square of ceil(r / 16) chunks round the middle chunk, and the shape moved onto the
 * middle chunk's middle with a radius of that many chunks and a half, tested on each chunk's middle.
 */
function chunkyCount(s: PregenSelection): number {
	const [rx, rz] = s.shape === 'rectangle' || s.shape === 'ellipse' ? [s.radius, s.radiusZ] : [s.radius, s.radius];
	const [ccx, ccz] = [Math.trunc(s.x) >> 4, Math.trunc(s.z) >> 4];
	const [rcx, rcz] = [Math.ceil(rx / 16), Math.ceil(rz / 16)];
	const [cx0, cz0, srx, srz] = [ccx * 16 + 8, ccz * 16 + 8, ((2 * rcx + 1) * 16) / 2, ((2 * rcz + 1) * 16) / 2];
	let n = 0;
	for (let cz = ccz - rcz; cz <= ccz + rcz; cz++) {
		for (let cx = ccx - rcx; cx <= ccx + rcx; cx++) {
			const [dx, dz] = [cx * 16 + 8 - cx0, cz * 16 + 8 - cz0];
			const inside =
				s.shape === 'circle'
					? Math.hypot(dx, dz) <= srx
					: s.shape === 'ellipse'
						? dx ** 2 / srx ** 2 + dz ** 2 / srz ** 2 <= 1
						: Math.abs(dx) <= srx && Math.abs(dz) <= srz;
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

	it('match what Chunky generated on a real 1.21.11 world: a square of 500 around 0, 0 is chunks -32 to 32', () => {
		// Read back from the world afterwards: 4225 chunks with Status full, x and z -32 to 32, so up to block 527.
		const s = sel({ radius: 500 });
		expect(selectionChunks(s)).toBe(4225);
		expect(selectionRows(s)).toEqual([-32, 32]);
		expect(rowRange(s, 32)).toEqual([-32, 32]);
		expect(chunkInSelection(s, 32, 0)).toBe(true);
		expect(chunkInSelection(s, 33, 0)).toBe(false);
	});

	it('give each row of chunks its first and last, for the outline', () => {
		// Radius 40: 3 chunks and a half round chunk 0's middle.
		const s = sel({ shape: 'circle', radius: 40 });
		expect(selectionRows(s)).toEqual([-3, 3]);
		expect(rowRange(s, 0)).toEqual([-3, 3]);
		expect(rowRange(s, 3)).toEqual([-1, 1]);
		expect(rowRange(s, 4)).toBeNull();
	});

	it('tell a chunk inside from one outside', () => {
		// Radius 100 around 0: 7 chunks each way (ceil(100 / 16)), so chunk 7 (blocks 112-127) is in, 8 not.
		expect(chunkInSelection(sel({}), 7, 0)).toBe(true);
		expect(chunkInSelection(sel({}), 8, 0)).toBe(false);
		expect(chunkInSelection(sel({}), -7, 7)).toBe(true);
		expect(chunkInSelection(sel({ shape: 'circle' }), 6, 6)).toBe(false);
	});

	it('find the chunks fully generated inside the selection, once each region is checked, and what one takes on disk', () => {
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
		const unchecked = existingInSelection(sel({ radius: 64 }), overview, new Map());
		expect(unchecked).toMatchObject({ existing: 0, unchecked: 1, toCheck: ['0,0'], known: 3, bytesPerChunk: 2 * 4096 });

		const result = existingInSelection(sel({ radius: 64 }), overview, new Map([['0,0', { notFull: [], unreadable: [] }]]));
		expect(result).toMatchObject({ existing: 1, unchecked: 0, toCheck: [] });
		expect([...result.regions.keys()]).toEqual(['0,0']);
		expect(result.regions.get('0,0')![0]).toBe(1);

		// Generated only partway (the rings round what was loaded): Chunky finishes it, so it is not counted.
		const partway = existingInSelection(sel({ radius: 64 }), overview, new Map([['0,0', { notFull: [0], unreadable: [] }]]));
		expect(partway).toMatchObject({ existing: 0, unchecked: 0 });
	});
});
