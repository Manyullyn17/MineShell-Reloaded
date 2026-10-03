import type { Tag, TagType } from './nbt';

/**
 * SNBT, the text form of NBT that commands and wikis use:
 * `{id:"minecraft:sharpness",lvl:5s}`, `[I;1,2,3]`, `1.5f`, `true`.
 *
 * Numbers take their type from the suffix (b, s, L, f, d; none = int, or
 * double with a decimal point), the same way Minecraft reads them; `true`
 * and `false` are bytes; anything else unquoted is a string. A list holds
 * one type, as in the binary format.
 */

export class SnbtError extends Error {}

const BARE = /[A-Za-z0-9._+-]/;
const INT_RANGES = { b: [-128, 127], s: [-32768, 32767], i: [-2147483648, 2147483647] } as const;

class Parser {
	pos = 0;
	private text: string;
	constructor(text: string) {
		this.text = text;
	}

	fail(message: string): never {
		throw new SnbtError(`${message} (at character ${this.pos + 1})`);
	}

	skip() {
		while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
	}

	peek() {
		this.skip();
		return this.text[this.pos];
	}

	expect(char: string) {
		if (this.peek() !== char) this.fail(`Expected "${char}"`);
		this.pos++;
	}

	quoted(): string {
		const quote = this.text[this.pos++];
		let out = '';
		while (this.pos < this.text.length) {
			const c = this.text[this.pos++];
			if (c === quote) return out;
			if (c !== '\\') {
				out += c;
				continue;
			}
			const e = this.text[this.pos++];
			if (e === 'n') out += '\n';
			else if (e === 't') out += '\t';
			else if (e === 'u') {
				const hex = this.text.slice(this.pos, this.pos + 4);
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('Bad \\u escape');
				out += String.fromCharCode(parseInt(hex, 16));
				this.pos += 4;
			} else if (e === undefined) this.fail('Unfinished escape');
			else out += e;
		}
		this.fail('Unfinished string');
	}

	bare(): string {
		this.skip();
		const start = this.pos;
		while (this.pos < this.text.length && BARE.test(this.text[this.pos])) this.pos++;
		if (this.pos === start) this.fail('Expected a value');
		return this.text.slice(start, this.pos);
	}

	key(): string {
		const c = this.peek();
		return c === '"' || c === "'" ? this.quoted() : this.bare();
	}

	value(depth = 0): Tag {
		if (depth > 512) this.fail('Nested too deeply');
		const c = this.peek();
		if (c === '{') return this.compound(depth);
		if (c === '[') return this.listOrArray(depth);
		if (c === '"' || c === "'") return { type: 'string', value: this.quoted() };
		if (c === undefined) this.fail('Expected a value');
		return scalar(this.bare(), (m) => this.fail(m));
	}

	compound(depth: number): Tag {
		this.expect('{');
		const value: [string, Tag][] = [];
		if (this.peek() === '}') {
			this.pos++;
			return { type: 'compound', value };
		}
		for (;;) {
			const name = this.key();
			if (value.some(([k]) => k === name)) this.fail(`"${name}" appears twice`);
			this.expect(':');
			value.push([name, this.value(depth + 1)]);
			if (this.peek() === ',') {
				this.pos++;
				continue;
			}
			this.expect('}');
			return { type: 'compound', value };
		}
	}

	listOrArray(depth: number): Tag {
		this.expect('[');
		const head = this.text.slice(this.pos).match(/^\s*([BIL])\s*;/);
		if (head) {
			this.pos += head[0].length;
			return this.array(head[1] as 'B' | 'I' | 'L');
		}
		const items: Tag[] = [];
		if (this.peek() === ']') {
			this.pos++;
			return { type: 'list', itemType: 'end', value: items };
		}
		for (;;) {
			const item = this.value(depth + 1);
			if (items.length && item.type !== items[0].type) this.fail(`A list holds one type; this one has ${items[0].type} and ${item.type}`);
			items.push(item);
			if (this.peek() === ',') {
				this.pos++;
				continue;
			}
			this.expect(']');
			return { type: 'list', itemType: items[0].type as TagType, value: items };
		}
	}

	array(kind: 'B' | 'I' | 'L'): Tag {
		const values: Tag[] = [];
		if (this.peek() !== ']') {
			for (;;) {
				values.push(scalar(this.bare(), (m) => this.fail(m), kind === 'B' ? 'byte' : kind === 'L' ? 'long' : 'int'));
				if (this.peek() === ',') {
					this.pos++;
					continue;
				}
				break;
			}
		}
		this.expect(']');
		if (kind === 'L') return { type: 'longArray', value: values.map((v) => (v as Extract<Tag, { type: 'long' }>).value) };
		return { type: kind === 'B' ? 'byteArray' : 'intArray', value: values.map((v) => (v as { value: number }).value) };
	}
}

/** An unquoted token: a typed number, true/false, or a string. In an array, `want` is the element type. */
function scalar(token: string, fail: (m: string) => never, want?: 'byte' | 'int' | 'long'): Tag {
	const integer = token.match(/^([-+]?\d+)([bBsSlLiI]?)$/);
	if (integer) {
		const suffix = integer[2].toLowerCase() || (want === 'byte' ? 'b' : want === 'long' ? 'l' : 'i');
		if (suffix === 'l') {
			const value = BigInt(integer[1]);
			if (value < -(2n ** 63n) || value >= 2n ** 63n) fail(`${token} is out of range for a long`);
			return { type: 'long', value };
		}
		const [min, max] = INT_RANGES[suffix as 'b' | 's' | 'i'];
		const value = Number(integer[1]);
		if (value < min || value > max) {
			// Minecraft reads an out-of-range unsuffixed number as a string.
			if (!integer[2] && !want) return { type: 'string', value: token };
			fail(`${token} is out of range`);
		}
		return { type: suffix === 'b' ? 'byte' : suffix === 's' ? 'short' : 'int', value };
	}
	if (want) fail(`${token} is not a whole number`);
	const decimal = token.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([fFdD]?)$/);
	if (decimal && (decimal[2] || /[.eE]/.test(decimal[1]))) {
		const value = Number(decimal[1]);
		return decimal[2].toLowerCase() === 'f' ? { type: 'float', value: Math.fround(value) } : { type: 'double', value };
	}
	if (token === 'true' || token === 'false') return { type: 'byte', value: token === 'true' ? 1 : 0 };
	return { type: 'string', value: token };
}

export function parseSnbt(text: string): Tag {
	const parser = new Parser(text);
	const tag = parser.value();
	if (parser.peek() !== undefined) parser.fail('Unexpected text after the value');
	return tag;
}
