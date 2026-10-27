/**
 * Tab bars scroll sideways on a phone (`.tabs`, `.subtabs`). Opening a page whose
 * current tab is past the bar's edge (World, Settings, a `?tab=` link) showed the
 * first few tabs and not where you are; this scrolls each bar until its current
 * tab is in view. Only the bar moves, never the page.
 */

/** The parts of an element this reads and sets, so a test can hand in plain objects. */
export type Bar = {
	scrollLeft: number;
	readonly clientWidth: number;
	querySelector(selector: string): { offsetLeft: number; offsetWidth: number } | null;
};

/** Room left beside the tab, so the next one peeks out and the bar's fade does not cover it. */
const MARGIN = 32;

/** Scrolls `bar` so its `[aria-current]` tab is in view; a tab already in view leaves it as it is. */
export function revealCurrentTab(bar: Bar): void {
	const tab = bar.querySelector('[aria-current]');
	if (!tab) return;
	const start = tab.offsetLeft;
	const end = start + tab.offsetWidth;
	if (start < bar.scrollLeft) bar.scrollLeft = Math.max(0, start - MARGIN);
	else if (end > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = end - bar.clientWidth + MARGIN;
}

/** Every tab bar on the page. */
export function revealCurrentTabs(root: ParentNode = document): void {
	for (const bar of root.querySelectorAll<HTMLElement>('.tabs, .subtabs')) revealCurrentTab(bar);
}
