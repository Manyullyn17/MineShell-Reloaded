import { describe, expect, it } from 'vitest';
import { dimensionRows } from './dimensionticks';

const dims = (...mspt: number[]) => mspt.map((m, i) => ({ id: `d${i}`, mspt: m }));
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe('dimensionRows', () => {
	it('shows a few dimensions whole, slowest first', () => {
		expect(dimensionRows(dims(0.2, 3, 0.01), false)).toEqual({ rows: [{ id: 'd1', mspt: 3 }, { id: 'd0', mspt: 0.2 }, { id: 'd2', mspt: 0.01 }], hidden: 0, idle: 0 });
	});

	it('starts a big pack with its busy ones and says how many idle ones wait behind', () => {
		const list = dims(5, 0.01, 2, 0.02, 0.3, 0, 0, 0, 0, 0);
		const { rows, hidden, idle } = dimensionRows(list, false);
		expect(ids(rows)).toEqual(['d0', 'd2', 'd4']);
		expect([hidden, idle]).toEqual([7, 7]);
		expect(dimensionRows(list, true).rows).toHaveLength(10);
	});

	it('stops at eight busy ones, counting only the idle among the rest', () => {
		const { rows, hidden, idle } = dimensionRows(dims(...Array(12).fill(1), 0, 0, 0), false);
		expect(rows).toHaveLength(8);
		expect([hidden, idle]).toEqual([7, 3]);
	});

	it('keeps three on an empty server, where every dimension is idle', () => {
		const { rows, hidden, idle } = dimensionRows(dims(0.05, 0.01, 0.02, 0, 0, 0), false);
		expect(ids(rows)).toEqual(['d0', 'd2', 'd1']);
		expect([hidden, idle]).toEqual([3, 3]);
	});

	it('shows one or two left over rather than a button for them', () => {
		expect(dimensionRows(dims(1, 0, 0, 0, 0), false).rows).toHaveLength(5);
	});
});
