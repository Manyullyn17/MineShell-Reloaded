import { describe, expect, it } from 'vitest';
import { diffLines, merge3 } from './configmerge';

const cfg = (...lines: string[]) => lines.map((l) => `${l}\n`).join('');

describe('three-way merge of config files', () => {
	const base = cfg('# Settings', 'enabled=true', 'radius=8', 'spawn=yes', 'colour=red', '# end');

	it('keeps both sides when they changed different lines', () => {
		const mine = cfg('# Settings', 'enabled=true', 'radius=32', 'spawn=yes', 'colour=red', '# end');
		const pack = cfg('# Settings', 'enabled=true', 'radius=8', 'spawn=yes', 'colour=blue', 'size=2', '# end');
		expect(merge3(base, mine, pack)).toEqual({
			text: cfg('# Settings', 'enabled=true', 'radius=32', 'spawn=yes', 'colour=blue', 'size=2', '# end'),
			conflicts: 0
		});
	});

	it('takes the pack’s lines where both changed the same ones, and counts it', () => {
		const mine = cfg('# Settings', 'enabled=false', 'radius=32', 'spawn=yes', 'colour=red', '# end');
		const pack = cfg('# Settings', 'enabled=true', 'radius=16', 'spawn=yes', 'colour=red', '# end');
		expect(merge3(base, mine, pack)).toEqual({
			text: cfg('# Settings', 'enabled=true', 'radius=16', 'spawn=yes', 'colour=red', '# end'),
			conflicts: 1
		});
	});

	it('is not a conflict when both made the same change', () => {
		const both = cfg('# Settings', 'enabled=true', 'radius=12', 'spawn=yes', 'colour=red', '# end');
		expect(merge3(base, both, both)).toEqual({ text: both, conflicts: 0 });
	});

	it('keeps lines the user added and lines the pack removed', () => {
		const mine = cfg('# Settings', 'enabled=true', 'radius=8', 'mine=1', 'spawn=yes', 'colour=red', '# end');
		const pack = cfg('# Settings', 'enabled=true', 'radius=8', 'spawn=yes', '# end');
		expect(merge3(base, mine, pack)).toEqual({ text: cfg('# Settings', 'enabled=true', 'radius=8', 'mine=1', 'spawn=yes', '# end'), conflicts: 0 });
	});

	it('gives back a file without a final newline exactly', () => {
		expect(merge3('a=1\nb=2', 'a=5\nb=2', 'a=1\nb=3')).toEqual({ text: 'a=5\nb=3', conflicts: 0 });
	});

	it('finds the smallest changes between two versions', () => {
		const a = ['x\n', 'a\n', 'b\n', 'c\n', 'y\n'];
		const b = ['x\n', 'a\n', 'B\n', 'c\n', 'new\n', 'y\n'];
		expect(diffLines(a, b)).toEqual([
			{ start: 2, end: 3, lines: ['B\n'] },
			{ start: 4, end: 4, lines: ['new\n'] }
		]);
	});
});
