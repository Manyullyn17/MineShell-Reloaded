/**
 * `use:reveal` on a panel that opens in place under the button that asked for it (a
 * confirmation, a rename, a form): when it opens past the bottom of the window, the
 * page scrolls just far enough to show it, instead of leaving its buttons out of
 * sight. A panel already in view does not move the page. Sticky bars count as not in
 * view: the headers at the top, a save bar pinned to the bottom.
 */
export function reveal(node: HTMLElement): void {
	requestAnimationFrame(() => {
		const box = node.getBoundingClientRect();
		const bottom = visibleBottom();
		if (box.bottom <= bottom) return;
		const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		// Its bottom into view, but never its top under the sticky headers: a tall panel shows from its start.
		window.scrollBy({ top: Math.min(box.bottom - bottom + 16, box.top - visibleTop() - 16), behavior: smooth ? 'smooth' : 'auto' });
	});
}

/** Where the page's sticky bars end (the top bar, a server's header and its section tabs). */
function visibleTop(): number {
	let top = 0;
	for (const el of document.querySelectorAll<HTMLElement>('.topbar, .sticky-head, .subhead, .settings-tabs')) {
		if (getComputedStyle(el).position !== 'sticky') continue;
		top = Math.max(top, el.getBoundingClientRect().bottom);
	}
	return top;
}

/** Where a save bar pinned to the bottom of the window starts (Settings with changes), else its bottom. */
function visibleBottom(): number {
	let bottom = window.innerHeight;
	for (const el of document.querySelectorAll<HTMLElement>('.savebar')) {
		const box = el.getBoundingClientRect();
		// Pinned: its bottom at the window's. One further down the page is not in the way yet.
		if (box.height && box.bottom >= window.innerHeight - 1 && box.top < window.innerHeight) bottom = Math.min(bottom, box.top);
	}
	return bottom;
}
