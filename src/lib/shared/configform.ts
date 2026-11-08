import { parse as parseToml } from 'smol-toml';
import JSON5 from 'json5';
import type { ConfigFormat } from './configfiles';

export { configFormatOf, whenApplied, type ConfigFormat } from './configfiles';

/**
 * Mod configs as a form: the settings of a NeoForge/Forge TOML, a Forge 1.12 `.cfg` or a
 * JSON/JSON5 file, each with where its value sits in the text. A change rewrites only that
 * value (`writeField`), so comments, order and spacing stay as the mod wrote them, and the
 * form is read again from the new text. Anything it cannot read for certain is refused
 * (`ConfigFormError`), and the file stays in the text editor.
 *
 * Hints come from the comments above a setting; the limits mods write into them become the
 * field's checks: NeoForge/Forge `# Range: 1 ~ 100`, `# Range: > 0`, `# Allowed Values: A, B`,
 * `# Default: 5`; Forge 1.12 `[range: 1 ~ 100, default: 5]` and a closing `Valid values:` list.
 */

export type FieldKind = 'boolean' | 'integer' | 'float' | 'string' | 'list' | 'raw';
export type ItemKind = 'string' | 'integer' | 'float';

export type ConfigField = {
	/** Stable across edits: section, key and which of that name it is. */
	id: string;
	key: string;
	kind: FieldKind;
	/** As the form shows it: numbers as written (longs go past what a JS number holds), a list's items as text, a raw value's text. */
	value: boolean | string | string[];
	/** A list's items. */
	items?: ItemKind;
	/** The comment above it, without the limit lines. */
	hint: string;
	/** Both allowed: NeoForge's `Range: > 0` means 0 or more. */
	min?: number;
	max?: number;
	choices?: string[];
	defaultText?: string;
	/** The value's text in the file: [start, end). */
	start: number;
	end: number;
	raw: string;
	/** The indent of the line the setting starts on, for lists written one item a line. */
	indent: string;
};

export type ConfigSection = { id: string; title: string; hint: string; depth: number; fields: ConfigField[] };
export type ParsedConfig = { format: ConfigFormat; sections: ConfigSection[]; count: number };

export class ConfigFormError extends Error {
	constructor(
		message: string,
		readonly line: number | null = null
	) {
		super(message);
	}
}

/** More settings than this make the form slower than the text. */
export const MAX_FIELDS = 3000;

export function readConfig(format: ConfigFormat, text: string): ParsedConfig {
	const sections = format === 'toml' ? readToml(text) : format === 'forgecfg' ? readForgeCfg(text) : readJson(text);
	const kept = sections.filter((s) => s.fields.length);
	const count = kept.reduce((sum, s) => sum + s.fields.length, 0);
	if (!count) throw new ConfigFormError('There are no settings in it for a form.');
	if (count > MAX_FIELDS) throw new ConfigFormError(`It has ${count} settings, more than the form shows (${MAX_FIELDS}).`);
	return { format, sections: kept, count };
}

function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
	return line;
}

function unsupported(text: string, offset: number, what: string): never {
	const line = lineOf(text, offset);
	throw new ConfigFormError(`Line ${line}: ${what}`, line);
}

/** Lines with where each starts, line endings left out. */
function linesOf(text: string): { start: number; text: string }[] {
	const out: { start: number; text: string }[] = [];
	let at = 0;
	for (const line of text.split('\n')) {
		out.push({ start: at, text: line.replace(/\r$/, '') });
		at += line.length + 1;
	}
	return out;
}

class Fields {
	sections: ConfigSection[] = [];
	private seen = new Map<string, number>();
	section(id: string, title: string, hint: string, depth: number): ConfigSection {
		const section = { id, title, hint, depth, fields: [] };
		this.sections.push(section);
		return section;
	}
	add(section: ConfigSection, field: Omit<ConfigField, 'id'>): void {
		const base = `${section.id}\u0000${field.key}`;
		const n = this.seen.get(base) ?? 0;
		this.seen.set(base, n + 1);
		section.fields.push({ id: n ? `${base}\u0000${n}` : base, ...field });
	}
}

// ------------------------------------------------------------------ limits ---

type Limits = Pick<ConfigField, 'min' | 'max' | 'choices' | 'defaultText'>;

/** NeoForge/Forge TOML comments: the limit lines out, into limits. */
function tomlHint(comments: string[]): { hint: string; limits: Limits } {
	const limits: Limits = {};
	const kept: string[] = [];
	for (const line of comments) {
		const range = line.match(/^Range:\s*(.+)$/);
		const allowed = line.match(/^Allowed Values:\s*(.*)$/);
		const def = line.match(/^Default:\s*(.*)$/);
		if (range) {
			const between = range[1].match(/^(\S+)\s*~\s*(\S+)$/);
			const above = range[1].match(/^>\s*(\S+)$/);
			const below = range[1].match(/^<\s*(\S+)$/);
			if (between) Object.assign(limits, { min: Number(between[1]), max: Number(between[2]) });
			else if (above) Object.assign(limits, { min: Number(above[1]) });
			else if (below) Object.assign(limits, { max: Number(below[1]) });
			else kept.push(line);
		} else if (allowed) limits.choices = allowed[1].split(',').map((c) => c.trim()).filter(Boolean);
		else if (def) limits.defaultText = def[1];
		// NeoForge writes "." for an empty comment line.
		else if (line !== '.') kept.push(line);
	}
	for (const key of ['min', 'max'] as const) if (limits[key] !== undefined && !Number.isFinite(limits[key])) delete limits[key];
	return { hint: kept.join('\n').trim(), limits };
}

/** Forge 1.12 comments: `[range: a ~ b, default: x]` at the end and a closing `Valid values:` list. */
function cfgHint(comments: string[]): { hint: string; limits: Limits } {
	const limits: Limits = {};
	const lines = [...comments];
	const valid = lines.map((l) => l.trim()).lastIndexOf('Valid values:');
	if (valid >= 0) {
		const after = lines.slice(valid + 1).map((l) => l.trim());
		if (after.length && after.every((c) => c && !/\s/.test(c))) {
			limits.choices = after;
			lines.splice(valid);
		}
	}
	const last = lines.length - 1;
	const meta = last >= 0 ? lines[last].match(/\s*\[(?:range:\s*(\S+)\s*~\s*(\S+),\s*)?default:\s*(.*)\]\s*$/) : null;
	if (meta) {
		if (meta[1] !== undefined) {
			const min = Number(meta[1]);
			const max = Number(meta[2]);
			if (Number.isFinite(min)) limits.min = min;
			if (Number.isFinite(max)) limits.max = max;
		}
		limits.defaultText = meta[3];
		lines[last] = lines[last].slice(0, meta.index);
	}
	return { hint: lines.join('\n').trim(), limits };
}

// -------------------------------------------------------------------- TOML ---

const BARE_KEY = /^[A-Za-z0-9_-]+/;

/** A dotted key at `at` (bare or quoted parts), and where it ends. */
function tomlKey(line: string, at: number): { parts: string[]; end: number } | null {
	const parts: string[] = [];
	let i = at;
	for (;;) {
		while (line[i] === ' ' || line[i] === '\t') i++;
		const rest = line.slice(i);
		const bare = rest.match(BARE_KEY);
		if (bare) {
			parts.push(bare[0]);
			i += bare[0].length;
		} else if (rest[0] === '"' || rest[0] === "'") {
			const close = rest[0] === '"' ? /^"((?:[^"\\]|\\.)*)"/ : /^'([^']*)'/;
			const m = rest.match(close);
			if (!m) return null;
			try {
				parts.push(rest[0] === '"' ? (JSON.parse(`"${m[1]}"`) as string) : m[1]);
			} catch {
				return null;
			}
			i += m[0].length;
		} else return null;
		while (line[i] === ' ' || line[i] === '\t') i++;
		if (line[i] !== '.') return { parts, end: i };
		i++;
	}
}

/** Where the TOML value starting at `at` ends. */
function tomlValueEnd(text: string, at: number): number {
	const c = text[at];
	if (text.startsWith('"""', at) || text.startsWith("'''", at)) {
		const q = text.slice(at, at + 3);
		let i = at + 3;
		for (;;) {
			const next = text.indexOf(q, i);
			if (next < 0) unsupported(text, at, 'a string that is not closed.');
			if (q === '"""') {
				let slashes = 0;
				for (let j = next - 1; text[j] === '\\'; j--) slashes++;
				if (slashes % 2) {
					i = next + 1;
					continue;
				}
			}
			let end = next + 3;
			// Up to two quotes may end the string's own text.
			while (text[end] === q[0] && end - next < 5) end++;
			return end;
		}
	}
	if (c === '"') {
		const m = text.slice(at).match(/^"(?:[^"\\\n]|\\.)*"/);
		if (!m) unsupported(text, at, 'a string that is not closed.');
		return at + m[0].length;
	}
	if (c === "'") {
		const close = text.indexOf("'", at + 1);
		if (close < 0 || text.slice(at, close).includes('\n')) unsupported(text, at, 'a string that is not closed.');
		return close + 1;
	}
	if (c === '[' || c === '{') {
		let depth = 0;
		let i = at;
		while (i < text.length) {
			const ch = text[i];
			if (ch === '"' || ch === "'") {
				i = tomlValueEnd(text, i);
				continue;
			}
			if (ch === '#') {
				const nl = text.indexOf('\n', i);
				i = nl < 0 ? text.length : nl;
				continue;
			}
			if (ch === '[' || ch === '{') depth++;
			else if (ch === ']' || ch === '}') {
				depth--;
				if (!depth) return i + 1;
			}
			i++;
		}
		unsupported(text, at, 'a list that is not closed.');
	}
	let i = at;
	while (i < text.length && text[i] !== '\n' && text[i] !== '\r' && text[i] !== '#') i++;
	while (i > at && (text[i - 1] === ' ' || text[i - 1] === '\t')) i--;
	return i;
}

/** NeoForge writes longs, past what a JS number holds: those are read as bigints. */
const TOML_OPTIONS = { integersAsBigInt: 'asNeeded' } as const;

function tomlValue(raw: string): unknown {
	return (parseToml(`v = ${raw}`, TOML_OPTIONS) as { v: unknown }).v;
}

function isFloatToken(raw: string): boolean {
	return /[.eE]|inf|nan/.test(raw) && !/^[+-]?0x/.test(raw);
}

/** The form's kind for a value as TOML gave it, and what the form shows. */
function tomlKind(raw: string, value: unknown): Pick<ConfigField, 'kind' | 'value' | 'items'> {
	if (typeof value === 'boolean') return { kind: 'boolean', value };
	if (typeof value === 'number' || typeof value === 'bigint') return { kind: isFloatToken(raw) ? 'float' : 'integer', value: raw };
	if (typeof value === 'string') return { kind: 'string', value };
	// A list with comments in it is edited as written, so they stay.
	if (Array.isArray(value) && !hasComment(raw, '#')) {
		const tokens = splitList(raw.slice(1, -1));
		if (value.every((v) => typeof v === 'string')) return { kind: 'list', items: 'string', value: value as string[] };
		if (value.every((v) => typeof v === 'number' || typeof v === 'bigint') && tokens && tokens.length === value.length) {
			const floats = tokens.some(isFloatToken);
			return { kind: 'list', items: floats ? 'float' : 'integer', value: tokens };
		}
	}
	return { kind: 'raw', value: raw };
}

/** Whether a comment starts in the value's text, outside its strings. */
function hasComment(raw: string, start: string): boolean {
	return raw.replace(/"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/g, '""').includes(start);
}

/** A list's items as written (numbers only: no strings or nesting), or null. */
function splitList(inner: string): string[] | null {
	const cleaned = inner.replace(/(#|\/\/)[^\n]*/g, '');
	if (/["'[\]{}]/.test(cleaned)) return null;
	return cleaned
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);
}

function readToml(text: string): ConfigSection[] {
	try {
		parseToml(text, TOML_OPTIONS);
	} catch (err) {
		const line = (err as { line?: number }).line ?? null;
		throw new ConfigFormError(`${line ? `Line ${line}: ` : ''}it is not valid TOML.`, line);
	}
	const out = new Fields();
	let section = out.section('', 'General', '', 0);
	let comments: string[] = [];
	const arrays = new Map<string, number>();
	const lines = linesOf(text);
	let skipTo = 0;
	for (const { start, text: line } of lines) {
		if (start < skipTo) continue;
		const trimmed = line.trim();
		if (!trimmed) {
			comments = [];
			continue;
		}
		if (trimmed.startsWith('#')) {
			comments.push(trimmed.replace(/^#\s?/, '').trimEnd());
			continue;
		}
		const indentLen = line.length - line.trimStart().length;
		if (trimmed.startsWith('[')) {
			const double = trimmed.startsWith('[[');
			const key = tomlKey(line, indentLen + (double ? 2 : 1));
			const close = key && line.slice(key.end).trimStart();
			if (!key || !close?.startsWith(double ? ']]' : ']')) unsupported(text, start, 'a table name the form cannot read.');
			const name = key.parts.join('.');
			const { hint } = tomlHint(comments);
			comments = [];
			if (double) {
				const n = arrays.get(name) ?? 0;
				arrays.set(name, n + 1);
				section = out.section(`${name}[${n}]`, `${key.parts.join(' › ')} (${n + 1})`, hint, key.parts.length);
			} else section = out.section(name, key.parts.join(' › '), hint, key.parts.length);
			continue;
		}
		const key = tomlKey(line, indentLen);
		if (!key || line[key.end] !== '=') unsupported(text, start, 'a line the form cannot read.');
		let at = start + key.end + 1;
		while (text[at] === ' ' || text[at] === '\t') at++;
		const end = tomlValueEnd(text, at);
		const raw = text.slice(at, end);
		let value: unknown;
		try {
			value = tomlValue(raw);
		} catch {
			unsupported(text, at, 'a value the form cannot read.');
		}
		const { hint, limits } = tomlHint(comments);
		comments = [];
		out.add(section, { key: key.parts.join('.'), ...tomlKind(raw, value), hint, ...limits, start: at, end, raw, indent: line.slice(0, indentLen) });
		skipTo = end;
	}
	return out.sections;
}

// --------------------------------------------------------- Forge 1.12 .cfg ---

const CFG_TYPES: Record<string, Exclude<FieldKind, 'list' | 'raw'>> = { B: 'boolean', I: 'integer', D: 'float', S: 'string' };

/** A bare or quoted name at the start of `s`, and the rest after it. */
function cfgName(s: string): { name: string; rest: string } | null {
	if (s.startsWith('"')) {
		const close = s.indexOf('"', 1);
		return close < 0 ? null : { name: s.slice(1, close), rest: s.slice(close + 1) };
	}
	const m = s.match(/^[^\s=<{}"]+/);
	return m ? { name: m[0], rest: s.slice(m[0].length) } : null;
}

/** The category banner Forge writes: rules of # and -, and the category's own name. */
function cfgCategoryHint(comments: string[], name: string): string {
	return comments
		.filter((l) => !/^[#-]*$/.test(l) && l !== name)
		.join('\n')
		.trim();
}

function readForgeCfg(text: string): ConfigSection[] {
	const out = new Fields();
	const stack: ConfigSection[] = [];
	const top = out.section('', 'General', '', 0);
	let comments: string[] = [];
	const lines = linesOf(text);
	for (let n = 0; n < lines.length; n++) {
		const { start, text: line } = lines[n];
		const trimmed = line.trim();
		if (!trimmed) {
			// Forge leaves a blank line between a category's banner and the category.
			if (!/^#{3,}$/.test(comments.at(-1) ?? '')) comments = [];
			continue;
		}
		if (trimmed.startsWith('#')) {
			comments.push(trimmed.replace(/^#\s?/, '').trimEnd());
			continue;
		}
		// ~CONFIG_VERSION and a category's ~ options.
		if (trimmed.startsWith('~')) continue;
		if (trimmed === '}') {
			if (!stack.length) unsupported(text, start, 'a } that closes nothing.');
			stack.pop();
			comments = [];
			continue;
		}
		const typed = trimmed.match(/^([A-Z]):/);
		if (!typed) {
			const name = cfgName(trimmed);
			if (!name || name.rest.trim() !== '{') unsupported(text, start, 'a line the form cannot read.');
			const parent = stack.at(-1);
			const id = parent ? `${parent.id}.${name.name}` : name.name;
			const title = parent ? `${parent.title} › ${name.name}` : name.name;
			stack.push(out.section(id, title, cfgCategoryHint(comments, name.name), stack.length + 1));
			comments = [];
			continue;
		}
		const indentLen = line.length - line.trimStart().length;
		const section = stack.at(-1) ?? top;
		const type = CFG_TYPES[typed[1]];
		// Up to the line's end: Forge reads a value as all of the line after the =.
		const body = line.slice(indentLen + 2);
		const name = cfgName(body);
		if (!name) unsupported(text, start, 'a setting name the form cannot read.');
		const { hint, limits } = cfgHint(comments);
		comments = [];
		const base = { key: name.name, hint, ...limits, indent: line.slice(0, indentLen) };
		if (name.rest.startsWith('=')) {
			const valueAt = start + indentLen + 2 + (body.length - name.rest.length) + 1;
			const raw = text.slice(valueAt, start + line.length);
			let value: boolean | string = raw;
			let kind: FieldKind = type ?? 'string';
			if (type === 'boolean' && /^(true|false)$/i.test(raw)) value = raw.toLowerCase() === 'true';
			// A value that is not of its type: shown as written, to be fixed.
			else if (type === 'boolean' || ((type === 'integer' || type === 'float') && (raw.trim() === '' || !Number.isFinite(Number(raw))))) kind = 'raw';
			out.add(section, { ...base, kind, value, start: valueAt, end: valueAt + raw.length, raw });
			continue;
		}
		if (name.rest.trim() !== '<') unsupported(text, start, 'a setting the form cannot read.');
		const first = n + 1;
		let close = first;
		while (close < lines.length && lines[close].text.trim() !== '>') close++;
		if (close >= lines.length) unsupported(text, start, 'a list that is not closed.');
		const listStart = lines[first].start;
		const listEnd = lines[close].start;
		const items = lines.slice(first, close).map((l) => l.text.trim()).filter(Boolean);
		const itemKind: ItemKind = type === 'integer' ? 'integer' : type === 'float' ? 'float' : 'string';
		out.add(section, { ...base, kind: 'list', items: itemKind, value: items, start: listStart, end: listEnd, raw: text.slice(listStart, listEnd) });
		n = close;
	}
	if (stack.length) unsupported(text, text.length, 'a category that is not closed.');
	return out.sections;
}

// -------------------------------------------------------------- JSON/JSON5 ---

class JsonScanner {
	i = 0;
	/** The comments just read, for the key after them. */
	comments: string[] = [];
	constructor(
		readonly text: string,
		readonly out: Fields
	) {}

	fail(what: string): never {
		unsupported(this.text, this.i, what);
	}

	/**
	 * Skips space and comments. Comments on lines of their own are kept for the key after
	 * them; a blank line drops them, and one after a value on its line is that value's.
	 */
	space(): void {
		const t = this.text;
		let newlines = 0;
		let ownLine = this.i === 0;
		for (;;) {
			const c = t[this.i];
			if (c === '\n') {
				if (++newlines >= 2) this.comments = [];
				ownLine = true;
				this.i++;
			} else if (c === ' ' || c === '\t' || c === '\r' || c === '\uFEFF') this.i++;
			else if (t.startsWith('//', this.i)) {
				const nl = t.indexOf('\n', this.i);
				const end = nl < 0 ? t.length : nl;
				if (ownLine) this.comments.push(t.slice(this.i + 2, end).trim());
				this.i = end;
				newlines = 0;
			} else if (t.startsWith('/*', this.i)) {
				const end = t.indexOf('*/', this.i + 2);
				if (end < 0) this.fail('a comment that is not closed.');
				if (ownLine) for (const l of t.slice(this.i + 2, end).split('\n')) this.comments.push(l.replace(/^\s*\*?\s?/, '').trimEnd());
				this.i = end + 2;
				newlines = 0;
			} else return;
		}
	}

	/** Where the scalar or string at i ends. */
	scalarEnd(): number {
		const t = this.text;
		const c = t[this.i];
		if (c === '"' || c === "'") {
			let j = this.i + 1;
			while (j < t.length && t[j] !== c) j += t[j] === '\\' ? 2 : 1;
			if (j >= t.length) this.fail('a string that is not closed.');
			return j + 1;
		}
		const m = t.slice(this.i).match(/^[^\s:,\]}/]+/);
		if (!m) this.fail('a value the form cannot read.');
		return this.i + m[0].length;
	}

	key(): string {
		const end = this.scalarEnd();
		const raw = this.text.slice(this.i, end);
		this.i = end;
		if (raw.startsWith('"') || raw.startsWith("'")) return JSON5.parse(raw) as string;
		return raw;
	}

	/** Skips a value, objects and lists included; returns where it ends. */
	skip(): number {
		const t = this.text;
		const open = t[this.i];
		if (open !== '{' && open !== '[') {
			this.i = this.scalarEnd();
			return this.i;
		}
		this.i++;
		for (;;) {
			this.space();
			const c = t[this.i];
			if (c === undefined) this.fail('a list that is not closed.');
			if (c === '}' || c === ']') {
				this.i++;
				return this.i;
			}
			if (c === ',' || c === ':') this.i++;
			else this.skip();
		}
	}

	lineIndent(at: number): string {
		const lineStart = this.text.lastIndexOf('\n', at - 1) + 1;
		return this.text.slice(lineStart).match(/^[ \t]*/)![0];
	}

	/**
	 * The object at i when it is one setting written as `{"//": description, "//default":
	 * default, "value": value}` (Darkhax's mods: Bookshelf, AttributeFix, Botany Pots, Open
	 * Loader; 209 files in ATM10): its value as one field with the description as its hint,
	 * read past the object. Null otherwise, with i where it was.
	 */
	describedValue(): Omit<ConfigField, 'id' | 'key' | 'indent'> | null {
		const from = this.i;
		// Skipping reads the comments inside; they stay the next key's only if this is not one setting.
		const comments = [...this.comments];
		const end = this.skip();
		this.i = from;
		this.comments = comments;
		let parsed: unknown;
		try {
			parsed = JSON5.parse(this.text.slice(from, end));
		} catch {
			return null;
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const o = parsed as Record<string, unknown>;
		const keys = Object.keys(o);
		if (!keys.includes('value') || !(keys.includes('//') || keys.includes('//default'))) return null;
		if (keys.some((k) => k !== 'value' && k !== '//' && k !== '//default')) return null;
		// The value's place in the text, read as any other: an object as the value is left as sections.
		const scratch: ConfigSection = { id: '', title: '', hint: '', depth: 0, fields: [] };
		const inner = new JsonScanner(this.text, new Fields());
		inner.i = from;
		inner.object(scratch, []);
		const value = scratch.fields.find((f) => f.key === 'value');
		if (!value) return null;
		const fallback = scratch.fields.find((f) => f.key === '//default');
		const note = o['//'];
		this.i = end;
		const { id: _id, key: _key, indent: _indent, ...field } = value;
		return {
			...field,
			// Long descriptions come as a list of lines padded to one width.
			hint: Array.isArray(note) ? note.map((l) => String(l).trim()).join(' ') : typeof note === 'string' ? note : '',
			...(fallback ? { defaultText: fallback.raw } : {})
		};
	}

	object(section: ConfigSection, path: string[]): void {
		const t = this.text;
		this.i++;
		for (;;) {
			this.space();
			if (t[this.i] === '}') {
				this.i++;
				return;
			}
			if (t[this.i] === ',') {
				this.i++;
				continue;
			}
			const keyAt = this.i;
			const key = this.key();
			const hint = this.comments.join('\n').trim();
			this.comments = [];
			this.space();
			if (t[this.i] !== ':') this.fail('a key without a value.');
			this.i++;
			this.space();
			this.comments = [];
			const start = this.i;
			const c = t[start];
			const described = c === '{' ? this.describedValue() : null;
			if (described) {
				this.out.add(section, { key, ...described, hint: [hint, described.hint].filter(Boolean).join('\n'), indent: this.lineIndent(keyAt) });
				continue;
			}
			if (c === '{') {
				const inner = [...path, key];
				const child = this.out.section(JSON.stringify(inner), inner.join(' › '), hint, inner.length);
				this.object(child, inner);
				continue;
			}
			const end = this.skip();
			const raw = t.slice(start, end);
			let value: unknown;
			try {
				value = JSON5.parse(raw);
			} catch {
				this.fail('a value the form cannot read.');
			}
			this.out.add(section, { key, ...jsonKind(raw, value), hint, start, end, raw, indent: this.lineIndent(keyAt) });
		}
	}
}

function jsonKind(raw: string, value: unknown): Pick<ConfigField, 'kind' | 'value' | 'items'> {
	if (typeof value === 'boolean') return { kind: 'boolean', value };
	if (typeof value === 'number') return { kind: /^-?\d+$/.test(raw) ? 'integer' : 'float', value: raw };
	if (typeof value === 'string') return { kind: 'string', value };
	if (Array.isArray(value) && !hasComment(raw, '//') && !hasComment(raw, '/*')) {
		if (value.every((v) => typeof v === 'string')) return { kind: 'list', items: 'string', value: value as string[] };
		const tokens = splitList(raw.slice(1, -1));
		if (value.length && value.every((v) => typeof v === 'number') && tokens?.length === value.length) {
			return { kind: 'list', items: tokens.some((tk) => !/^-?\d+$/.test(tk)) ? 'float' : 'integer', value: tokens };
		}
	}
	return { kind: 'raw', value: raw };
}

function readJson(text: string): ConfigSection[] {
	try {
		JSON5.parse(text);
	} catch (err) {
		const line = (err as { lineNumber?: number }).lineNumber ?? null;
		throw new ConfigFormError(`${line ? `Line ${line}: ` : ''}it is not valid JSON.`, line);
	}
	const out = new Fields();
	const scan = new JsonScanner(text, out);
	scan.space();
	if (text[scan.i] !== '{') throw new ConfigFormError('It is a list, not settings by name.');
	const top = out.section('', 'General', scan.comments.join('\n').trim(), 0);
	scan.comments = [];
	scan.object(top, []);
	return out.sections;
}

// ----------------------------------------------------------------- writing ---

export type FieldInput = boolean | string | string[];

/** Why a value cannot go in, or null. Numbers and lists come as text, as typed. */
export function checkField(format: ConfigFormat, field: ConfigField, input: FieldInput): string | null {
	const number = (s: string, kind: ItemKind): string | null => {
		const t = s.trim();
		if (kind === 'integer' && !/^[+-]?\d+$/.test(t)) return `"${s}" is not a whole number.`;
		if (kind === 'float' && (t === '' || !Number.isFinite(Number(t)))) return `"${s}" is not a number.`;
		const n = Number(t);
		const { min, max } = field;
		if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
			if (min !== undefined && max !== undefined) return `It has to be from ${min} to ${max}.`;
			return min !== undefined ? `It has to be at least ${min}.` : `It has to be at most ${max}.`;
		}
		return null;
	};
	switch (field.kind) {
		case 'integer':
		case 'float':
			return number(String(input), field.kind);
		case 'list': {
			if (!Array.isArray(input)) return 'Not a list.';
			if (field.items === 'string') {
				if (format === 'forgecfg' && input.some((s) => s.trim() === '>')) return 'An item cannot be only ">".';
				return null;
			}
			for (const item of input) {
				const problem = number(item, field.items ?? 'string');
				if (problem) return problem;
			}
			return null;
		}
		case 'string':
			if (format === 'forgecfg' && /[\r\n]/.test(String(input))) return 'It has to be one line.';
			if (field.choices?.length && !field.choices.includes(String(input))) return `It has to be one of ${field.choices.join(', ')}.`;
			return null;
		case 'raw':
			try {
				if (format === 'toml') tomlValue(String(input));
				else if (format === 'json') JSON5.parse(String(input));
				else if (/[\r\n]/.test(String(input))) return 'It has to be one line.';
			} catch {
				return format === 'toml' ? 'That is not a TOML value.' : 'That is not a JSON value.';
			}
			return null;
		default:
			return null;
	}
}

function tomlString(field: ConfigField, s: string): string {
	// A literal string stays one where it can.
	if (field.raw.startsWith("'") && !field.raw.startsWith("'''") && !/['\n\r\x00-\x08\x0b-\x1f\x7f]/.test(s)) return `'${s}'`;
	return JSON.stringify(s).replace(/\x7f/g, '\\u007F');
}

/** A number as typed where the format takes it so (`1.6E7` stays), else in the format's own form. */
function numberText(s: string, kind: ItemKind, format: ConfigFormat): string {
	const t = s.trim();
	if (kind === 'integer') return /^-?(0|[1-9]\d*)$/.test(t) ? t : String(BigInt(t.replace(/^\+/, '')));
	if (format === 'forgecfg') return t;
	if (format === 'json') return /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(t) ? t : String(Number(t));
	// TOML keeps a float a float only with a point or exponent.
	if (/^[+-]?(0|[1-9]\d*)$/.test(t)) return `${t}.0`;
	if (/^[+-]?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return t;
	const text = String(Number(t));
	return /^-?\d+$/.test(text) ? `${text}.0` : text;
}

/** A list in the shape it had: one line, or one item a line. */
function listText(field: ConfigField, items: string[]): string {
	if (!items.length) return '[]';
	const multiline = field.raw.includes('\n');
	if (!multiline) return `[${items.join(', ')}]`;
	const firstItem = field.raw.match(/\[[^\S\n]*\n([ \t]*)/);
	const inner = firstItem?.[1] || `${field.indent}\t`;
	return `[\n${items.map((i) => inner + i).join(',\n')}\n${field.indent}]`;
}

/** The value as the file writes it. Checked with checkField first. */
export function valueText(format: ConfigFormat, field: ConfigField, input: FieldInput): string {
	if (field.kind === 'raw') return String(input);
	if (format === 'forgecfg') {
		if (field.kind === 'list') {
			const indent = field.raw.match(/^[ \t]*(?=\S)/)?.[0] || `${field.indent}    `;
			return (input as string[]).map((i) => `${indent}${i.trim()}\n`).join('');
		}
		if (field.kind === 'boolean') return String(input);
		if (field.kind === 'integer' || field.kind === 'float') return numberText(String(input), field.kind, format);
		return String(input);
	}
	if (field.kind === 'boolean') return String(input);
	if (field.kind === 'integer' || field.kind === 'float') return numberText(String(input), field.kind, format);
	const str = (s: string) => (format === 'toml' ? tomlString(field, s) : JSON.stringify(s));
	if (field.kind === 'string') return str(String(input));
	const items = input as string[];
	return listText(field, field.items === 'string' ? items.map(str) : items.map((i) => numberText(i, field.items!, format)));
}

/** The file with this one value changed, everything else as it was. */
export function writeField(text: string, format: ConfigFormat, field: ConfigField, input: FieldInput): string {
	if (JSON.stringify(input) === JSON.stringify(field.value)) return text;
	return text.slice(0, field.start) + valueText(format, field, input) + text.slice(field.end);
}
