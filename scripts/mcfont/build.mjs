#!/usr/bin/env node
/**
 * MineShell Pixel, the font the Minecraft text previews draw in (ServerListPreview,
 * ResourcePackPromptPreview): glyphs.mjs written out as an OpenType font, one square per pixel
 * (runs merged), 128 units a pixel, 8 pixels an em (ascent 7, descent 1). Each glyph is checked
 * against the game's advance for it (mcfontwidths.ts), so text in it is as long as in game.
 * Drawn for MineShell, not taken from the game; characters it lacks fall back to the UI font.
 *
 *   node scripts/mcfont/build.mjs      rewrites static/fonts/mcfont.otf after a glyph change
 *
 * src/lib/shared/mcfont.test.ts fails while the committed file's outlines and advances are not
 * what this builds (not its bytes: opentype.js writes the time into the font's "modified").
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import { GLYPHS } from './glyphs.mjs';
import { GLYPH_WIDTHS } from '../../src/lib/shared/mcfontwidths.ts';

const U = 128;
export const FONT_FILE = fileURLToPath(new URL('../../static/fonts/mcfont.otf', import.meta.url));

const WIDTH = new Map();
for (const [width, chars] of Object.entries(GLYPH_WIDTHS)) for (const c of chars) WIDTH.set(c, Number(width));
/** @param {string} c */
const advance = (c) => WIDTH.get(c) ?? 6;

/** Where glyphs.mjs does not fit the game's advances; empty when it does. */
export function glyphProblems() {
	const problems = [];
	for (let code = 33; code < 127; code++) {
		const ch = String.fromCharCode(code);
		const rows = GLYPHS[ch];
		if (!rows) {
			problems.push(`${ch}: missing`);
			continue;
		}
		const cols = advance(ch) - 1;
		if (rows.length > 8) problems.push(`${ch}: ${rows.length} rows, at most 8`);
		rows.forEach((/** @type {string} */ r, /** @type {number} */ i) => r.length !== cols && problems.push(`${ch}: row ${i} is ${r.length} wide, the game's advance makes it ${cols}`));
	}
	return problems;
}

export function buildFont() {
	const problems = glyphProblems();
	if (problems.length) throw new Error(problems.join('\n'));
	const glyphs = [
		new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 6 * U, path: new opentype.Path() }),
		new opentype.Glyph({ name: 'space', unicode: 32, advanceWidth: advance(' ') * U, path: new opentype.Path() })
	];
	for (let code = 33; code < 127; code++) {
		const ch = String.fromCharCode(code);
		const p = new opentype.Path();
		GLYPHS[ch].forEach((/** @type {string} */ row, /** @type {number} */ r) => {
			const top = (7 - r) * U;
			for (let c = 0; c < row.length; c++) {
				if (row[c] !== '#') continue;
				let end = c;
				while (row[end + 1] === '#') end++;
				// Clockwise with y up: the outer direction TrueType expects.
				p.moveTo(c * U, top);
				p.lineTo((end + 1) * U, top);
				p.lineTo((end + 1) * U, top - U);
				p.lineTo(c * U, top - U);
				p.close();
				c = end;
			}
		});
		glyphs.push(new opentype.Glyph({ name: `u${code.toString(16).padStart(4, '0')}`, unicode: code, advanceWidth: advance(ch) * U, path: p }));
	}
	const font = new opentype.Font({
		familyName: 'MineShell Pixel',
		styleName: 'Regular',
		unitsPerEm: 8 * U,
		ascender: 7 * U,
		descender: -U,
		createdTimestamp: Date.UTC(2026, 10, 11) / 1000,
		glyphs
	});
	return font;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	fs.mkdirSync(path.dirname(FONT_FILE), { recursive: true });
	fs.writeFileSync(FONT_FILE, Buffer.from(buildFont().toArrayBuffer()));
	console.log(`wrote ${path.relative(process.cwd(), FONT_FILE)}`);
}
