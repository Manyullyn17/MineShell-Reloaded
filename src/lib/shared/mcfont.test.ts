import fs from 'node:fs';
import opentype from 'opentype.js';
import { describe, expect, it } from 'vitest';
import { buildFont, FONT_FILE, glyphProblems } from '../../../scripts/mcfont/build.mjs';

describe("the previews' pixel font", () => {
	it("draws every printable ASCII character as wide as the game's advance for it", () => {
		expect(glyphProblems()).toEqual([]);
	});

	it('is committed as scripts/mcfont/build.mjs builds it from the glyphs', () => {
		const file = fs.readFileSync(FONT_FILE);
		const committed = opentype.parse(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
		const built = buildFont();
		for (let code = 32; code < 127; code++) {
			const ch = String.fromCharCode(code);
			const [a, b] = [committed.charToGlyph(ch), built.charToGlyph(ch)];
			expect({ ch, advance: a.advanceWidth, path: a.path.toPathData(0) }).toEqual({ ch, advance: b.advanceWidth, path: b.path.toPathData(0) });
		}
	});
});
