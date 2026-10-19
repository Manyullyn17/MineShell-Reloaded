/**
 * The screenshots, one entry each (README.md here). Written to
 * docs/screenshots/<name>.png. Options are tests/tools/pageshot.mjs's:
 *   path      page on the throwaway server
 *   waitFor   text the page shows once it has what the picture needs
 *   width     viewport width (default 1280; 390 is a phone)
 *   height    exactly this tall (default 800)
 *   element   capture only this element
 *   steps     [{ click: selector } | { eval: js }] in order, once loaded
 *   settle    ms to wait after loading before the picture (live numbers, graphs)
 */

/**
 * Pages opened once before the pictures, for what happens in the browser on a
 * first visit: a pack server's overview gives it the pack's icon.
 */
export const visits = ['/instances/cobblemon', '/instances/meatballcraft'];

/** @type {{ name: string; path: string; waitFor?: string; width?: number; height?: number; element?: string; steps?: ({ click: string } | { eval: string })[]; settle?: number }[]} */
export const shots = [
	{ name: 'servers', path: '/', waitFor: 'MeatballCraft', height: 900 },
	{ name: 'overview', path: '/instances/survival', waitFor: 'ms/tick', settle: 3000, height: 1000 },
	{ name: 'console', path: '/instances/survival/console', waitFor: 'gg' },
	{ name: 'mods', path: '/instances/meatballcraft/mods', waitFor: 'AbyssalCraft', height: 1100 },
	{ name: 'overview-phone', path: '/instances/survival', waitFor: 'ms/tick', settle: 3000, width: 390, height: 844 }
];
