import type { LayoutServerLoad } from './$types';
import { curseforgeKeySource, curseforgeKeyValid } from '#lib/server/curseforge.js';

export const load: LayoutServerLoad = () => ({
	// The tab is marked when a key is set but not working; no key at all is a valid choice.
	integrationsWarning: curseforgeKeySource() !== 'none' && !curseforgeKeyValid()
});
