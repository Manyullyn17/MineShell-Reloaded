/**
 * `use:reveal` on a panel that opens in place under the button that asked for it (a
 * confirmation, a rename, a form): when it opens past the bottom of the window, the
 * page scrolls just far enough to show it, instead of leaving its buttons out of
 * sight. A panel already in view does not move the page.
 */
export function reveal(node: HTMLElement): void {
	requestAnimationFrame(() => {
		const box = node.getBoundingClientRect();
		if (box.bottom <= window.innerHeight) return;
		const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		// Its bottom into view, but never its top under the sticky headers: a tall panel shows from its start.
		window.scrollBy({ top: Math.min(box.bottom - window.innerHeight + 16, box.top - stickyBottom() - 16), behavior: smooth ? 'smooth' : 'auto' });
	});
}

/** Where the page's sticky bars end (the top bar, a server's header and its section tabs). */
function stickyBottom(): number {
	let bottom = 0;
	for (const el of document.querySelectorAll<HTMLElement>('.topbar, .sticky-head, .subhead, .settings-tabs')) {
		if (getComputedStyle(el).position !== 'sticky') continue;
		bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
	}
	return bottom;
}
