import { describe, expect, it } from 'vitest';
import { fromJson, glyphWidth, hasHex, parseCodes, plainText, textWidth, toCodes, toJson, wrapLines } from './mctext';

describe('§ codes', () => {
	it('read as the game reads them', () => {
		expect(parseCodes('§6§lGold §rplain')).toEqual([
			{ color: 'gold', bold: true, text: 'Gold ' },
			{ text: 'plain' }
		]);
		// A colour ends bold and the rest; codes are case-blind; an unknown one and a final § go.
		expect(parseCodes('§lA§cB§LC§zD§')).toEqual([
			{ bold: true, text: 'A' },
			{ color: 'red', text: 'B' },
			{ color: 'red', bold: true, text: 'CD' }
		]);
		// §r goes back to the style around the text, not to nothing.
		expect(parseCodes('§aA§rB', { italic: true })).toEqual([
			{ color: 'green', text: 'A' },
			{ italic: true, text: 'B' }
		]);
		expect(parseCodes('§#12abEFhex')).toEqual([{ color: '#12abef', text: 'hex' }]);
	});

	it('come back with as few codes as read the same', () => {
		expect(toCodes(parseCodes('§aA§lB§r§aC'))).toBe('§aA§lB§aC');
		for (const text of ['§6§lGold §rplain', '§aA§lB§aC', '§#12abefhex§7 grey', 'no codes', '§lbold§obolder']) {
			expect(toCodes(parseCodes(text)), text).toBe(text);
		}
		// A format dropped needs the colour again.
		expect(toCodes([{ color: 'red', bold: true, text: 'A' }, { color: 'red', text: 'B' }])).toBe('§c§lA§cB');
		expect(plainText('§6§lGold §rplain')).toBe('Gold plain');
		expect(hasHex('§#123456x')).toBe(true);
		expect(hasHex('§6x')).toBe(false);
	});
});

describe('JSON text', () => {
	it('reads the plain parts, inheriting style, and refuses what it cannot hold', () => {
		expect(fromJson({ text: 'A', color: 'gold', extra: [{ text: 'B', bold: true }, 'C'] })).toEqual([
			{ color: 'gold', text: 'A' },
			{ color: 'gold', bold: true, text: 'B' },
			{ color: 'gold', text: 'C' }
		]);
		// An array's first element styles the rest; NBT text's bytes count as booleans.
		expect(fromJson([{ text: '', color: 'red' }, 'x', { text: 'y', italic: 1 }])).toEqual([
			{ color: 'red', text: 'x' },
			{ color: 'red', italic: true, text: 'y' }
		]);
		// An item name without `italic` is italic in game.
		expect(fromJson({ text: 'Sword' }, { italic: true })).toEqual([{ italic: true, text: 'Sword' }]);
		expect(fromJson({ text: 'Sword', italic: false }, { italic: true })).toEqual([{ text: 'Sword' }]);
		for (const v of [{ translate: 'item.minecraft.stick' }, { text: 'a', clickEvent: {} }, { text: 'a', color: 'pinkish' }, { text: 'a', font: 'x' }]) {
			expect(fromJson(v), JSON.stringify(v)).toBeNull();
		}
		expect(fromJson({ text: 'a', extra: [{ score: {} }] })).toBeNull();
	});

	it('writes spans inside a root style, saying only what differs', () => {
		expect(toJson(parseCodes('Sword'), { italic: false })).toEqual({ italic: false, text: 'Sword' });
		expect(toJson(parseCodes('§6Gold §o§lshiny'), { italic: false })).toEqual({
			text: '',
			italic: false,
			extra: [
				{ text: 'Gold ', color: 'gold' },
				{ text: 'shiny', color: 'gold', bold: true, italic: true }
			]
		});
		// Round trip: an anvil name read as italic stays italic under a non-italic root.
		const anvil = fromJson({ text: 'Sword' }, { italic: true })!;
		expect(fromJson(toJson(parseCodes(toCodes(anvil)), { italic: false }), { italic: true })).toEqual(anvil);
	});
});

describe('widths and lines', () => {
	it('measures as the game does', () => {
		expect(glyphWidth('a')).toBe(6);
		expect(glyphWidth('i')).toBe(2);
		expect(glyphWidth(' ')).toBe(4);
		expect(glyphWidth('a', true)).toBe(7);
		expect(textWidth(parseCodes('§lii'))).toBe(6);
	});

	it('breaks after the last space that fits, else at the character', () => {
		const lines = (text: string, width: number) => wrapLines(parseCodes(text), width).map((l) => l.map((s) => s.text).join(''));
		// "aaaa " is 28 wide: "aaaa bbbb" (52) does not fit 40.
		expect(lines('aaaa bbbb', 40)).toEqual(['aaaa', 'bbbb']);
		expect(lines('aaaaaaaaaa', 30)).toEqual(['aaaaa', 'aaaaa']);
		expect(lines('one\ntwo', 200)).toEqual(['one', 'two']);
		// Styles carry over the break.
		expect(wrapLines(parseCodes('§caaaa bbbb'), 40)[1]).toEqual([{ color: 'red', text: 'bbbb' }]);
	});
});
