import { GLYPH_WIDTHS } from './mcfontwidths';

/**
 * Minecraft's formatted text, one model for every place it is typed: `§` codes in a string
 * (server.properties' motd, item names before 1.13), JSON text (names and lore 1.13 to
 * 1.21.4) and NBT text (1.21.5 on, converted to the JSON shape by playeritems.ts).
 *
 * The editors work on a `§`-coded string. Hex colours, which only JSON and NBT text can hold,
 * are written `§#rrggbb` there: MineShell's own notation, never stored as such.
 */

export type Style = {
	/** A colour name (`gold`) or `#rrggbb`. */
	color?: string;
	bold?: boolean;
	italic?: boolean;
	underlined?: boolean;
	strikethrough?: boolean;
	obfuscated?: boolean;
};
export type Span = Style & { text: string };

export const COLORS: { code: string; name: string; hex: string }[] = [
	{ code: '0', name: 'black', hex: '#000000' },
	{ code: '1', name: 'dark_blue', hex: '#0000AA' },
	{ code: '2', name: 'dark_green', hex: '#00AA00' },
	{ code: '3', name: 'dark_aqua', hex: '#00AAAA' },
	{ code: '4', name: 'dark_red', hex: '#AA0000' },
	{ code: '5', name: 'dark_purple', hex: '#AA00AA' },
	{ code: '6', name: 'gold', hex: '#FFAA00' },
	{ code: '7', name: 'gray', hex: '#AAAAAA' },
	{ code: '8', name: 'dark_gray', hex: '#555555' },
	{ code: '9', name: 'blue', hex: '#5555FF' },
	{ code: 'a', name: 'green', hex: '#55FF55' },
	{ code: 'b', name: 'aqua', hex: '#55FFFF' },
	{ code: 'c', name: 'red', hex: '#FF5555' },
	{ code: 'd', name: 'light_purple', hex: '#FF55FF' },
	{ code: 'e', name: 'yellow', hex: '#FFFF55' },
	{ code: 'f', name: 'white', hex: '#FFFFFF' }
];

export const FORMATS: { code: string; key: keyof Omit<Style, 'color'>; label: string }[] = [
	{ code: 'l', key: 'bold', label: 'Bold' },
	{ code: 'o', key: 'italic', label: 'Italic' },
	{ code: 'n', key: 'underlined', label: 'Underlined' },
	{ code: 'm', key: 'strikethrough', label: 'Strikethrough' },
	{ code: 'k', key: 'obfuscated', label: 'Obfuscated' }
];

const FORMAT_KEYS = FORMATS.map((f) => f.key);
const HEX = /^#[0-9a-fA-F]{6}$/;

/** A colour as CSS, for drawing it. */
export function colorHex(color: string | undefined): string | undefined {
	if (!color) return undefined;
	return HEX.test(color) ? color : COLORS.find((c) => c.name === color)?.hex;
}

// ----------------------------------------------------------------- § codes ---

/**
 * A `§`-coded string as the game reads it: a colour ends bold, italic and the rest; `§r` goes
 * back to `base` (the style around the text: an item name's italic); an unknown code is
 * dropped with its `§`, as is a `§` at the very end.
 */
export function parseCodes(text: string, base: Style = {}): Span[] {
	const spans: Span[] = [];
	let style: Style = { ...base };
	let buffer = '';
	const flush = () => {
		if (buffer) spans.push({ ...clean(style), text: buffer });
		buffer = '';
	};
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== '§') {
			buffer += text[i];
			continue;
		}
		const hex = text.slice(i + 1, i + 8);
		if (HEX.test(hex)) {
			flush();
			style = { color: hex.toLowerCase() };
			i += 7;
			continue;
		}
		const code = (text[i + 1] ?? '').toLowerCase();
		i++;
		const color = COLORS.find((c) => c.code === code);
		const format = FORMATS.find((f) => f.code === code);
		if (!color && !format && code !== 'r') continue;
		flush();
		if (color) style = { color: color.name };
		else if (format) style = { ...style, [format.key]: true };
		else style = { ...base };
	}
	flush();
	return spans;
}

/** Only what is set: `false` and a missing key both mean "not". */
function clean(style: Style): Style {
	const out: Style = {};
	if (style.color) out.color = style.color;
	for (const key of FORMAT_KEYS) if (style[key]) out[key] = true;
	return out;
}

function colorCode(color: string): string {
	return HEX.test(color) ? `§${color.toLowerCase()}` : `§${COLORS.find((c) => c.name === color)?.code ?? 'r'}`;
}

/** Spans back to a `§`-coded string, with as few codes as the game needs to read them so. */
export function toCodes(spans: Span[]): string {
	let out = '';
	let prev: Style = {};
	for (const span of spans) {
		if (!span.text) continue;
		const style = clean(span);
		const dropped = style.color !== prev.color || FORMAT_KEYS.some((k) => prev[k] && !style[k]);
		if (dropped) {
			out += style.color ? colorCode(style.color) : '§r';
			for (const f of FORMATS) if (style[f.key]) out += `§${f.code}`;
		} else {
			for (const f of FORMATS) if (style[f.key] && !prev[f.key]) out += `§${f.code}`;
		}
		out += span.text;
		prev = style;
	}
	return out;
}

/** The codes that set exactly `style` from anywhere: its colour (or `§r`), then its formats. */
export function codesFor(style: Style): string {
	const clean_ = clean(style);
	return (clean_.color ? colorCode(clean_.color) : '§r') + FORMATS.filter((f) => clean_[f.key]).map((f) => `§${f.code}`).join('');
}

/** The style in effect at the end of `codes` (what the next typed letter gets). */
export function styleAt(codes: string): Style {
	return clean(parseCodes(`${codes}\u0000`).at(-1)!);
}

/** The text without its codes. */
export function plainText(codes: string): string {
	return parseCodes(codes)
		.map((s) => s.text)
		.join('');
}

export function hasHex(codes: string): boolean {
	return /§#[0-9a-fA-F]{6}/.test(codes);
}

// -------------------------------------------------------------- JSON text ---

/** What a component may hold to be shown and edited here; anything else is kept as it is. */
const PLAIN_KEYS = new Set(['text', 'type', 'extra', 'color', ...FORMAT_KEYS]);
const COLOR_NAMES = new Set(COLORS.map((c) => c.name));

/**
 * A JSON text component (or NBT text in the same shape) as spans, each with the style it
 * inherits from `base` and its parents. Null when it holds what the model cannot: translated
 * text, a score, click or hover events, a font, an unknown colour.
 */
export function fromJson(value: unknown, base: Style = {}): Span[] | null {
	if (typeof value === 'string') return parseCodes(value, base);
	if (typeof value === 'number' || typeof value === 'boolean') return [{ ...clean(base), text: String(value) }];
	if (Array.isArray(value)) {
		// The first element's style carries to the rest.
		if (!value.length) return [];
		const first = fromJson(value[0], base);
		const inherited = ownStyle(value[0], base);
		if (!first || !inherited) return null;
		const rest = value.slice(1).map((v) => fromJson(v, inherited));
		return rest.some((r) => r === null) ? null : [...first, ...(rest as Span[][]).flat()];
	}
	if (!value || typeof value !== 'object') return null;
	const own = ownStyle(value, base);
	if (!own) return null;
	const v = value as { text?: unknown; type?: unknown; extra?: unknown };
	if (v.type !== undefined && v.type !== 'text') return null;
	const spans = typeof v.text === 'string' || typeof v.text === 'number' ? parseCodes(String(v.text), own) : [];
	if (v.extra === undefined) return spans;
	if (!Array.isArray(v.extra)) return null;
	const extra = v.extra.map((e) => fromJson(e, own));
	return extra.some((e) => e === null) ? null : [...spans, ...(extra as Span[][]).flat()];
}

function ownStyle(value: unknown, base: Style): Style | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return typeof value === 'string' ? base : null;
	const v = value as Record<string, unknown>;
	if (Object.keys(v).some((k) => !PLAIN_KEYS.has(k))) return null;
	const style: Style = { ...base };
	if (v.color !== undefined) {
		if (typeof v.color !== 'string') return null;
		if (v.color === 'reset') delete style.color;
		else if (COLOR_NAMES.has(v.color) || HEX.test(v.color)) style.color = HEX.test(v.color) ? v.color.toLowerCase() : v.color;
		else return null;
	}
	// NBT text has bytes where JSON has booleans.
	for (const key of FORMAT_KEYS) if (v[key] !== undefined) style[key] = v[key] === true || v[key] === 1;
	return style;
}

/**
 * Spans as a JSON text component: `root` around them (item names and lore are written with
 * `italic: false`, so typed text is not made italic), each span saying only what differs.
 */
export function toJson(spans: Span[], root: Style = {}): Record<string, unknown> {
	const parts = spans.filter((s) => s.text).map((s) => {
		const part: Record<string, unknown> = { text: s.text };
		const style = clean(s);
		if (style.color) part.color = style.color;
		for (const key of FORMAT_KEYS) if (!!style[key] !== !!root[key]) part[key] = !!style[key];
		return part;
	});
	const rootKeys = Object.fromEntries(Object.entries(root).filter(([, v]) => v !== undefined));
	if (parts.length === 1) {
		const { text, ...rest } = parts[0];
		return { text, ...rootKeys, ...rest };
	}
	return { text: '', ...rootKeys, extra: parts };
}

// ------------------------------------------------------- widths and lines ---

const WIDTHS = new Map<number, number>();
for (const [width, chars] of Object.entries(GLYPH_WIDTHS)) for (const c of chars) WIDTHS.set(c.codePointAt(0)!, Number(width));

/**
 * A character's advance in the game's font. Ones the bitmap fonts lack come from Unifont:
 * wide (CJK and the like) 9, the rest 6, close enough for the line breaks.
 */
export function glyphWidth(char: string, bold = false): number {
	const code = char.codePointAt(0)!;
	const width = WIDTHS.get(code) ?? (code >= 0x2e80 && code <= 0xffef ? 9 : 6);
	return width + (bold && width > 0 ? 1 : 0);
}

export function textWidth(spans: Span[]): number {
	let width = 0;
	for (const span of spans) for (const c of span.text) width += glyphWidth(c, span.bold);
	return width;
}

/**
 * Spans broken into lines the way the game does: at each newline, and where a line would pass
 * `maxWidth`, after the last space before that (the space goes), else at that character.
 */
export function wrapLines(spans: Span[], maxWidth: number): Span[][] {
	type Char = { c: string; style: Style };
	const chars: Char[] = spans.flatMap((s) => [...s.text].map((c) => ({ c, style: clean(s) })));
	const lines: Char[][] = [];
	let line: Char[] = [];
	let width = 0;
	let lastSpace = -1;
	for (const ch of chars) {
		if (ch.c === '\n') {
			lines.push(line);
			line = [];
			width = 0;
			lastSpace = -1;
			continue;
		}
		const w = glyphWidth(ch.c, ch.style.bold);
		if (width + w > maxWidth && line.length) {
			if (lastSpace >= 0) {
				lines.push(line.slice(0, lastSpace));
				line = line.slice(lastSpace + 1);
			} else {
				lines.push(line);
				line = [];
			}
			width = line.reduce((n, x) => n + glyphWidth(x.c, x.style.bold), 0);
			lastSpace = line.findLastIndex((x) => x.c === ' ');
		}
		if (ch.c === ' ') lastSpace = line.length;
		line.push(ch);
		width += w;
	}
	lines.push(line);
	return lines.map((l) => {
		const out: Span[] = [];
		for (const { c, style } of l) {
			const last = out.at(-1);
			if (last && JSON.stringify(clean(last)) === JSON.stringify(style)) last.text += c;
			else out.push({ ...style, text: c });
		}
		return out;
	});
}
