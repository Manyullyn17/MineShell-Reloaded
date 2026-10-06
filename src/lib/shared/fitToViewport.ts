export type FitToViewportParams =
	| number
	| {
			bottomMarginPx?: number;
			/**
			 * A sibling that appears below the node in normal flow - e.g. a
			 * details section that shows up once something in the list above
			 * gets selected. Its current height is subtracted from the node's
			 * budget too, so the pair keeps fitting the viewport together
			 * instead of the node staying full-height and pushing the sibling
			 * (and the page) past the bottom of the screen. Pass the element
			 * itself (not a getter) so Svelte's reactivity re-runs `update`
			 * the moment it mounts, unmounts, or is swapped for another one -
			 * a callback closing over it would hide that change from Svelte,
			 * since reading state inside a nested function isn't tracked the
			 * way reading it directly in the attribute expression is.
			 */
			reserveElement?: HTMLElement | null;
			/**
			 * An absolute ceiling as a fraction of the viewport height (e.g.
			 * 0.66), applied regardless of how much room is actually left
			 * below the node. Without this, a tall enough viewport lets the
			 * node fill nearly the whole screen just because the space is
			 * there - fine for a short list, too much for one with a couple
			 * dozen rows.
			 */
			maxViewportFraction?: number;
	  };

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
 *
 * `document.body` itself is pinned to 100% height (see app.css), so it
 * never actually resizes just because its content overflows - the
 * ResizeObserver on it mostly just covers font/zoom-driven reflow. A
 * reserved sibling's own size changes (an error message appearing inside
 * it, its version list loading in) need their own observer on that element
 * to be caught at all.
 */
export function fitToViewport(node: HTMLElement, params: FitToViewportParams = 24) {
	let bottomMarginPx = typeof params === 'number' ? params : params.bottomMarginPx ?? 24;
	let reserveElement = typeof params === 'number' ? null : params.reserveElement ?? null;
	let maxViewportFraction = typeof params === 'number' ? undefined : params.maxViewportFraction;

	function recompute() {
		const top = node.getBoundingClientRect().top;
		const reservedHeight = reserveElement?.getBoundingClientRect().height ?? 0;
		const remaining = window.innerHeight - top - bottomMarginPx;
		const budget = maxViewportFraction != null ? Math.min(remaining, maxViewportFraction * window.innerHeight) : remaining;
		const available = budget - reservedHeight;
		node.style.maxHeight = `${Math.max(available, 0)}px`;
	}

	recompute();
	window.addEventListener('resize', recompute);

	const bodyObserver = new ResizeObserver(recompute);
	bodyObserver.observe(document.body);
	// A node mounted inside a hidden section (a later step of a form) measures
	// from the top of the screen and gets the whole viewport; nothing above
	// changes size when the section is shown, but the node itself does (from
	// 0). Re-measuring on its own size changes is stable: the same top gives
	// the same max-height.
	bodyObserver.observe(node);

	// ResizeObserver fires once immediately on observe() with the current
	// size, so pointing it at a freshly-mounted reserveElement also covers
	// the very first recompute for it - no need to call recompute() again
	// here just for that.
	const reserveObserver = new ResizeObserver(recompute);
	if (reserveElement) reserveObserver.observe(reserveElement);

	return {
		update(nextParams: FitToViewportParams) {
			bottomMarginPx = typeof nextParams === 'number' ? nextParams : nextParams.bottomMarginPx ?? 24;
			maxViewportFraction = typeof nextParams === 'number' ? undefined : nextParams.maxViewportFraction;
			const nextReserveElement = typeof nextParams === 'number' ? null : nextParams.reserveElement ?? null;
			if (nextReserveElement !== reserveElement) {
				if (reserveElement) reserveObserver.unobserve(reserveElement);
				reserveElement = nextReserveElement;
				if (reserveElement) reserveObserver.observe(reserveElement);
			}
			recompute();
		},
		destroy() {
			window.removeEventListener('resize', recompute);
			bodyObserver.disconnect();
			reserveObserver.disconnect();
		}
	};
}
