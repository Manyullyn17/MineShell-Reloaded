import { describe, expect, it } from 'vitest';
import { IDENTITY, modelQuads, rotX, translate, chain } from './entityicons';

const round = (v: number[]) => v.map((n) => Math.round(n * 1000) / 1000 || 0);

describe('model parts to faces', () => {
	// One 2x4x1 box at texture (0,0) on a 64-wide texture: 16 units are 64 pixels.
	const quads = modelQuads([{ cubes: [{ uv: [0, 0], box: [0, 0, 0, 2, 4, 1] }] }], IDENTITY, 'minecraft:t', 64);
	const face = (x: number, y: number, z: number) => quads.find((q) => q.normal.every((n, i) => Math.abs(n - [x, y, z][i]) < 1e-9))!;

	it("gives each face the texture rectangle and corners the game's Cube gives it", () => {
		expect(quads).toHaveLength(6);
		// North (z min): (d, d) to (d+w, d+h), its top left at the max-x top corner (vertex 1 of Polygon).
		expect(face(0, 0, -1).face.uv).toEqual([0.25, 0.25, 0.75, 1.25]);
		expect(face(0, 0, -1).corners).toEqual([
			[0, 0, 0],
			[2, 0, 0],
			[0, 4, 0]
		]);
		// Down (y min) is the first square of the top row, up (y max) the second, read upside down.
		expect(face(0, -1, 0).face.uv).toEqual([0.25, 0, 0.75, 0.25]);
		expect(face(0, 1, 0).face.uv).toEqual([0.75, 0.25, 1.25, 0]);
		// West, east and south along the row below.
		expect(face(-1, 0, 0).face.uv).toEqual([0, 0.25, 0.25, 1.25]);
		expect(face(1, 0, 0).face.uv).toEqual([0.75, 0.25, 1, 1.25]);
		expect(face(0, 0, 1).face.uv).toEqual([1, 0.25, 1.5, 1.25]);
		expect(new Set(quads.map((q) => q.group))).toEqual(new Set([0]));
	});

	it('mirrors a box as the game does: sides swapped, faces still outward', () => {
		const mirrored = modelQuads([{ cubes: [{ uv: [0, 0], box: [0, 0, 0, 2, 4, 1], mirror: true }] }], IDENTITY, 'minecraft:t', 64);
		// Min and max x swap places, so the face pointing to -x carries the east square and the one
		// pointing to +x the west square - each still on its own side, facing out.
		const minX = mirrored.find((q) => q.normal[0] < -0.5)!;
		const maxX = mirrored.find((q) => q.normal[0] > 0.5)!;
		expect(minX.face.uv).toEqual([0.75, 0.25, 1, 1.25]);
		expect(minX.corners.every((c) => c[0] === 0)).toBe(true);
		expect(maxX.face.uv).toEqual([0, 0.25, 0.25, 1.25]);
		expect(maxX.corners.every((c) => c[0] === 2)).toBe(true);
	});

	it('places children inside their parents, turned and moved, and numbers each box', () => {
		const parts = [
			{
				offset: [0, 10, 0] as [number, number, number],
				cubes: [{ uv: [0, 0] as [number, number], box: [0, 0, 0, 1, 1, 1] as [number, number, number, number, number, number] }],
				children: [{ offset: [5, 0, 0] as [number, number, number], rotation: [Math.PI / 2, 0, 0] as [number, number, number], cubes: [{ uv: [0, 0] as [number, number], box: [0, 0, 0, 1, 2, 1] as [number, number, number, number, number, number] }] }]
			}
		];
		const placed = modelQuads(parts, chain(translate(1, 0, 0), rotX(0)), 'minecraft:t', 16);
		const child = placed.filter((q) => q.group === 1);
		const xs = child.flatMap((q) => q.corners.map((c) => c[0]));
		const ys = child.flatMap((q) => q.corners.map((c) => c[1]));
		const zs = child.flatMap((q) => q.corners.map((c) => c[2]));
		// x: 1 (outer) + 5 (child); turned 90 about x, its 2 high side now runs along z.
		expect([Math.min(...xs), Math.max(...xs)]).toEqual([6, 7]);
		expect(round([Math.min(...ys), Math.max(...ys)])).toEqual([9, 10]);
		expect(round([Math.min(...zs), Math.max(...zs)])).toEqual([0, 2]);
	});
});
