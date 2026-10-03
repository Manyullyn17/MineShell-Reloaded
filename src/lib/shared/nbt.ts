/**
 * NBT as the browser sees it (a JSON-safe tree) and SNBT, the text form
 * commands use (`{id:"minecraft:sharpness",lvl:5s}`), printed from it.
 * Parsing SNBT happens on the server (`lib/server/snbt.ts`).
 */

export type TagType =
	| 'end'
	| 'byte'
	| 'short'
	| 'int'
	| 'long'
	| 'float'
	| 'double'
	| 'byteArray'
	| 'string'
	| 'list'
	| 'compound'
	| 'intArray'
	| 'longArray';

/** A path into the tree: compound keys and list indices. */
export type Path = (string | number)[];

/** A tag in JSON: longs as strings, non-finite floats as strings. */
export type TreeTag =
	| { type: 'byte' | 'short' | 'int' | 'float' | 'double'; value: number | string }
	| { type: 'long' | 'string'; value: string }
	| { type: 'byteArray' | 'intArray'; value: number[] }
	| { type: 'longArray'; value: string[] }
	| { type: 'list'; itemType: TagType; value: TreeTag[] }
	| { type: 'compound'; value: [string, TreeTag][] };

const BARE_KEY = /^[A-Za-z0-9._+-]+$/;

export function quoteSnbt(text: string): string {
	return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** SNBT for a tree tag; `indent` > 0 spreads compounds and lists over lines. */
export function treeToSnbt(tag: TreeTag, indent = 0, depth = 0): string {
	const pad = (d: number) => (indent ? '\n' + ' '.repeat(indent * d) : '');
	const join = (parts: string[]) =>
		parts.length === 0 ? '' : indent ? parts.map((p) => pad(depth + 1) + p).join(',') + pad(depth) : parts.join(',');
	switch (tag.type) {
		case 'byte':
			return `${tag.value}b`;
		case 'short':
			return `${tag.value}s`;
		case 'int':
			return String(tag.value);
		case 'long':
			return `${tag.value}L`;
		case 'float':
			return `${tag.value}f`;
		case 'double':
			return `${tag.value}d`;
		case 'string':
			return quoteSnbt(tag.value);
		case 'byteArray':
			return `[B;${tag.value.map((v) => `${v}b`).join(',')}]`;
		case 'intArray':
			return `[I;${tag.value.join(',')}]`;
		case 'longArray':
			return `[L;${tag.value.map((v) => `${v}L`).join(',')}]`;
		case 'list':
			return `[${join(tag.value.map((v) => treeToSnbt(v, indent, depth + 1)))}]`;
		case 'compound':
			return `{${join(tag.value.map(([k, v]) => `${BARE_KEY.test(k) ? k : quoteSnbt(k)}:${indent ? ' ' : ''}${treeToSnbt(v, indent, depth + 1)}`))}}`;
	}
}
