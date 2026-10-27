import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'svelte/compiler';

/**
 * Svelte drops the whitespace at the start and end of every block branch ({#if}, {:else},
 * {#each}, {#key}, {#await}), so `{#if n}peak {n} · {/if}<a>` renders "peak 3 ·<a>" and
 * `{date}{#if by} by {by}{/if}` renders "…10:00by admin". A space that has to stay is written
 * `{' · '}` or moved outside the block. Only branches whose text runs straight on into what
 * is around the block count: a line break or a space outside it keeps the words apart.
 */

type Node = { type: string; start: number; data?: string; [key: string]: unknown };
type Fragment = { nodes: Node[] };

const BLOCK_BRANCHES: Record<string, string[]> = {
	IfBlock: ['consequent', 'alternate'],
	EachBlock: ['body', 'fallback'],
	KeyBlock: ['fragment'],
	AwaitBlock: ['pending', 'then', 'catch']
};

/** Spaces (no line break) at a text's start or end. */
const leading = (s: string) => /^[ \t]+/.test(s);
const trailing = (s: string) => /[ \t]+$/.test(s);

function lostSpaces(source: string): number[] {
	const found: number[] = [];
	const ast = parse(source, { modern: true }) as unknown as { fragment: Fragment; instance?: unknown };

	const fragmentsOf = (node: Node): Fragment[] =>
		Object.values(node).filter((v): v is Fragment => !!v && typeof v === 'object' && Array.isArray((v as Fragment).nodes));

	/** One branch of a block, with whether the text before and after the block runs straight on. */
	function checkBranch(branch: Fragment | null | undefined, gluedBefore: boolean, gluedAfter: boolean) {
		if (!branch?.nodes.length) return;
		const { nodes } = branch;
		// An {:else if} is an IfBlock alone in the alternate: its branches sit where this block does.
		if (nodes.length === 1 && nodes[0].type === 'IfBlock' && nodes[0].elseif) {
			for (const key of BLOCK_BRANCHES.IfBlock) checkBranch(nodes[0][key] as Fragment, gluedBefore, gluedAfter);
			return;
		}
		const first = nodes[0];
		const last = nodes[nodes.length - 1];
		if (gluedBefore && first.type === 'Text' && leading(first.data!) && (nodes.length > 1 || /\S/.test(first.data!))) found.push(first.start);
		if (gluedAfter && last.type === 'Text' && trailing(last.data!) && (nodes.length > 1 || /\S/.test(last.data!))) found.push(last.start);
	}

	function walk(fragment: Fragment) {
		fragment.nodes.forEach((node, i) => {
			const branches = BLOCK_BRANCHES[node.type];
			if (branches) {
				const prev = fragment.nodes[i - 1];
				const next = fragment.nodes[i + 1];
				const gluedBefore = !!prev && !(prev.type === 'Text' && /\s$/.test(prev.data!));
				const gluedAfter = !!next && !(next.type === 'Text' && /^\s/.test(next.data!));
				for (const key of branches) checkBranch(node[key] as Fragment, gluedBefore, gluedAfter);
			}
			for (const child of fragmentsOf(node)) walk(child);
		});
	}

	walk(ast.fragment);
	return found.map((offset) => source.slice(0, offset).split('\n').length);
}

describe('spaces at the edge of a template block', () => {
	it('are found where Svelte would drop them', () => {
		expect(lostSpaces('<p>{#if a}peak {a} · {/if}<a>all</a></p>')).toEqual([1]);
		expect(lostSpaces('<td>{d}{#if b} by {b}{/if}</td>')).toEqual([1]);
		expect(lostSpaces('<p>{#if a}one {:else if b}two {:else}three {/if}<b>z</b></p>')).toEqual([1, 1, 1]);
		expect(lostSpaces('<p>{#each xs as x}{x}, {/each}<b>z</b></p>')).toEqual([1]);
	});

	it('are left alone where the words stay apart anyway', () => {
		expect(lostSpaces("<p>{#if a}peak {a}{' · '}{/if}<a>all</a></p>")).toEqual([]);
		expect(lostSpaces('<p>{#if a}peak {a} · {/if} <a>all</a></p>')).toEqual([]);
		expect(lostSpaces('<p>x {#if a} y{/if}</p>')).toEqual([]);
		expect(lostSpaces('<p>{#if a}\n\t\t<b>y</b>\n\t{/if}\n</p>')).toEqual([]);
	});

	const files = fs.globSync('src/**/*.svelte');

	it.each(files)('none in %s', (file) => {
		expect(lostSpaces(fs.readFileSync(file, 'utf8')).map((line) => `${file}:${line}`)).toEqual([]);
	});
});
