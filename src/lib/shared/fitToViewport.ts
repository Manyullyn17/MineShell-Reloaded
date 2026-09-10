/**
 * Caps an element's max-height at whatever room is actually left below its
 * own top edge in the viewport, instead of a hard-coded `calc(100vh - Nrem)`
 * guess. A fixed offset has to account for the height of every sibling
 * above the element - the page header, a flash message that may or may not
 * be showing, wrapped text at a narrow width - and goes stale the moment
 * any of that changes; a `ResizeObserver` on `document.body` re-measures
 * whenever any of it actually does, and a plain resize listener covers the
 * viewport itself changing size. `min-height` set in CSS still wins over
 * this on a very short viewport, per the cascade, so a floor is set there
 * rather than here.
 */
export function fitToViewport(node: HTMLElement, bottomMarginPx = 24) {
	function recompute() {
		const top = node.getBoundingClientRect().top;
		const available = window.innerHeight - top - bottomMarginPx;
		node.style.maxHeight = `${Math.max(available, 0)}px`;
	}

	recompute();
	window.addEventListener('resize', recompute);
	const observer = new ResizeObserver(recompute);
	observer.observe(document.body);

	return {
		update(nextBottomMarginPx: number) {
			bottomMarginPx = nextBottomMarginPx;
			recompute();
		},
		destroy() {
			window.removeEventListener('resize', recompute);
			observer.disconnect();
		}
	};
}
