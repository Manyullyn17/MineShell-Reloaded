import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'svelte/compiler';

/**
 * Browsers keep what was typed into a text box by its name (else its id) and offer it again in
 * every box of that name on the site: the prune area's name box offered servers', worlds' and
 * files' names, eleven boxes being called "name". Nothing typed here is worth offering again,
 * so every text box says `autocomplete="off"`; only sign-in, setup and account fields name what
 * they are, for password managers. The CurseForge key is a password box only to hide it: its
 * "new-password" keeps saved sign-ins out of it.
 */

type Node = { type: string; start: number; name?: string; attributes?: Attribute[]; [key: string]: unknown };
type Attribute = { type: string; name?: string; value: true | { type: string; data?: string }[] | { type: string } };
type Fragment = { nodes: Node[] };

const NOT_TYPED_INTO = new Set(['hidden', 'checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'range', 'color']);
const ALLOWED = new Set(['off', 'username', 'current-password', 'new-password']);

/** The attribute's text when it is written out, null when it is an expression. */
function staticValue(attribute: Attribute): string | null {
	if (attribute.value === true) return '';
	if (!Array.isArray(attribute.value)) return null;
	return attribute.value.every((part) => part.type === 'Text') ? attribute.value.map((part) => part.data).join('') : null;
}

/** Lines of text boxes without `autocomplete`, or with a value other than off and the sign-in ones. */
function unmarked(source: string): number[] {
	const found: number[] = [];
	const ast = parse(source, { modern: true }) as unknown as { fragment: Fragment };

	function walk(value: unknown) {
		if (!value || typeof value !== 'object') return;
		if (Array.isArray(value)) return value.forEach(walk);
		const node = value as Node;
		if (node.type === 'RegularElement' && (node.name === 'input' || node.name === 'textarea')) {
			const attributes = node.attributes ?? [];
			const type = attributes.find((a) => a.type === 'Attribute' && a.name === 'type');
			const typed = node.name === 'textarea' || !type || !NOT_TYPED_INTO.has(staticValue(type) ?? '');
			const autocomplete = attributes.find((a) => a.type === 'Attribute' && a.name === 'autocomplete');
			if (typed && (!autocomplete || !ALLOWED.has(staticValue(autocomplete) ?? ''))) found.push(node.start);
		}
		for (const [key, child] of Object.entries(node)) if (key !== 'parent') walk(child);
	}

	walk(ast.fragment);
	return found.map((offset) => source.slice(0, offset).split('\n').length);
}

describe('text boxes the browser offers old entries in', () => {
	it('are found', () => {
		expect(unmarked('<input name="name" />')).toEqual([1]);
		expect(unmarked('<input type="number" name="radius" />')).toEqual([1]);
		expect(unmarked('<textarea name="notes"></textarea>')).toEqual([1]);
		expect(unmarked('{#if a}<p><input type={kind} /></p>{/if}')).toEqual([1]);
		expect(unmarked('<input name="name" autocomplete="on" />')).toEqual([1]);
		expect(unmarked('<input name="name" autocomplete={x} />')).toEqual([1]);
	});

	it('are left alone when marked, or not typed into', () => {
		expect(unmarked('<input name="name" autocomplete="off" />')).toEqual([]);
		expect(unmarked('<input name="password" type="password" autocomplete="current-password" />')).toEqual([]);
		expect(unmarked('<input type="checkbox" name="x" /><input type="hidden" name="y" value="1" />')).toEqual([]);
	});

	const files = fs.globSync('src/**/*.svelte');

	it.each(files)('none in %s', (file) => {
		expect(unmarked(fs.readFileSync(file, 'utf8')).map((line) => `${file}:${line}`)).toEqual([]);
	});
});
