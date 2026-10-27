/**
 * The screenshots, one entry each (README.md here). Written to
 * docs/screenshots/<name>.png. Options are tests/tools/pageshot.mjs's:
 *   path      page on the throwaway server, or a function of the scenes' `ctx.vars` giving it
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

/** @type {{ name: string; path: string | ((vars: Record<string, string>) => string); waitFor?: string; width?: number; height?: number; element?: string; steps?: ({ click: string } | { eval: string })[]; settle?: number }[]} */
export const shots = [
	{ name: 'servers', path: '/', waitFor: 'MeatballCraft', height: 900 },
	// Ends above Setup's Directory row, which shows the throwaway /tmp/ms-shots path.
	{ name: 'overview', path: '/instances/survival', waitFor: 'ms/tick', settle: 3000, height: 900 },
	{ name: 'console', path: '/instances/survival/console', waitFor: 'gg' },
	// The Cobblemon pack's newest version previewed against the installed one (Settings > General > Modpack;
	// the overview's update notice links here the same way): mods updated, added, removed, configs moved.
	{
		name: 'pack-update',
		path: (vars) => `/instances/cobblemon/settings?packVersion=${vars.cobblemonNewest}`,
		waitFor: 'Pack mods:',
		// Its list of mod changes opened, once the preview is there.
		steps: [
			{
				eval: `(async () => {
					for (let i = 0; i < 120; i++) {
						const list = [...document.querySelectorAll('#modpack details')].find((d) => d.textContent.includes('Pack mod changes'));
						if (list) return (list.open = true);
						await new Promise((r) => setTimeout(r, 500));
					}
				})()`
			}
		],
		// The panel itself: the section's own top sits under the settings' sticky save bar.
		element: '#modpack .embedded'
	},
	{ name: 'overview-phone', path: '/instances/survival', waitFor: 'ms/tick', settle: 3000, width: 390, height: 844 },
	// Feature sections: one picture each, the page without the sidebar.
	// The crashed server's overview, its last-output panel: the verdict, the button that fixes it, the log.
	{ name: 'crash', path: '/instances/creative', waitFor: 'Disable Simple Datapacks', element: 'main.content section.panel' },
	{
		// World > Pre-generate on Cobblemon (its real world, Chunky installed): a circle of 500 blocks
		// round spawn on the chunk map, with how many chunks are new and about how much disk they take.
		name: 'pregen',
		path: '/instances/cobblemon/world',
		// Tall, since the map's height follows the window's.
		height: 1300,
		element: 'form.planner',
		steps: [
			{ click: '.subtabs button:nth-of-type(3)' },
			{
				eval: `(async () => {
					const wait = (ms) => new Promise((r) => setTimeout(r, ms));
					const form = document.querySelector('form.planner');
					form.querySelector('input[name=shape][value=circle]').click();
					await wait(300);
					[...form.querySelectorAll('button')].find((b) => b.textContent.trim() === '500').click();
					for (let i = 0; i < 60 && !/to generate/.test(form.textContent); i++) await wait(500);
					// Fitted again once the map is up: a fit asked for while it starts can be lost to its first view.
					[...form.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Show all of it').click();
					await wait(2000);
					return true;
				})()`
			}
		]
	},
	// A player's inventory on Cobblemon (the world scene's file for Bramblewick, offline UUID), with the game's own item pictures.
	{ name: 'player', path: '/instances/cobblemon/players/03ada41f-ef51-3b32-80b9-702ef95b4b72', waitFor: 'Bramblewick', height: 820, settle: 4000 },
	{
		// Add a server, step 2: Modrinth searched for Cobblemon, its official pack opened (live).
		name: 'packs',
		path: '/instances/new',
		height: 900,
		element: 'main.content',
		steps: [
			{ click: '.bottombar .button-primary' },
			{ eval: searchAndOpen('Search modpacks', 'cobblemon', 0) }
		]
	},
	{
		// Add mods on the Cobblemon server: Modrinth's popular Fabric 1.21.1 mods, installed ones marked, one not yet installed opened (live).
		name: 'mod-browser',
		path: '/instances/cobblemon/mods',
		height: 900,
		element: 'main.content',
		steps: [{ click: '.subtabs button:nth-of-type(3)' }, { eval: searchAndOpen(null, null, 1) }]
	}
];

/**
 * Types a search (when given) into the field labelled `label`, waits for the
 * results, and opens the `nth` one; resolves once its details have loaded.
 * @param {string | null} label @param {string | null} term @param {number} nth
 */
function searchAndOpen(label, term, nth) {
	return `(async () => {
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		await wait(3000);
		${
			term
				? `const input = document.querySelector('input[aria-label="${label}"]');
		input.value = ${JSON.stringify(term)};
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await wait(4000);`
				: ''
		}
		document.querySelectorAll('.hits .hit')[${nth}].click();
		await wait(5000);
		return true;
	})()`;
}
