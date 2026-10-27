import { describe, expect, it } from 'vitest';
import { revealCurrentTab, type Bar } from './tabbars';

/** A bar 390 px wide, scrolled to `scrollLeft`, whose current tab spans `left` to `left + width`. */
const bar = (scrollLeft: number, tab: { left: number; width: number } | null): Bar => ({
	scrollLeft,
	clientWidth: 390,
	querySelector: () => (tab ? { offsetLeft: tab.left, offsetWidth: tab.width } : null)
});

describe('a tab bar on a phone', () => {
	it('scrolls to a current tab past its right edge (World, Settings)', () => {
		const b = bar(0, { left: 560, width: 80 });
		revealCurrentTab(b);
		expect(b.scrollLeft).toBe(560 + 80 - 390 + 32);
	});

	it('scrolls back to a current tab before its left edge', () => {
		const b = bar(400, { left: 100, width: 80 });
		revealCurrentTab(b);
		expect(b.scrollLeft).toBe(68);
	});

	it('leaves a bar alone when the current tab is in view, or there is none', () => {
		const shown = bar(0, { left: 120, width: 80 });
		revealCurrentTab(shown);
		expect(shown.scrollLeft).toBe(0);
		const none = bar(50, null);
		revealCurrentTab(none);
		expect(none.scrollLeft).toBe(50);
	});
});
