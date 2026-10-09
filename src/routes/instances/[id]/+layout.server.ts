import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getInstance, summarise } from '#lib/server/instances.js';
import { getCountdown } from '#lib/server/countdown.js';
import { activeProfile, hasSpark } from '#lib/server/spark.js';
import { primaryLanAddress } from '#lib/server/network.js';
import { LOADERS } from '#lib/server/modloaders.js';
import { playitStatus, publicAddress, serverTunnel } from '#lib/server/playit.js';
import type { ModloaderId } from '#lib/server/modloaders.js';

export const load: LayoutServerLoad = async ({ params, url }) => {
	const instance = getInstance(params.id);
	if (!instance) error(404, 'No server with that name.');

	const summary = await summarise(instance);
	return {
		instance: {
			id: instance.id,
			name: instance.name,
			path: instance.path,
			minecraftVersion: instance.minecraftVersion,
			modloader: instance.modloader,
			// The stored value is the internal id ('fabric'); the registry holds the
			// display spelling ('Fabric'). Only the label should ever reach the UI.
			modloaderLabel: LOADERS[instance.modloader as ModloaderId]?.label ?? instance.modloader,
			modloaderVersion: instance.modloaderVersion,
			packName: instance.packName,
			packVersionName: instance.packVersionName,
			serverPort: instance.serverPort,
			status: instance.status,
			statusMessage: instance.statusMessage,
			pinned: instance.pinned,
			consoleBufferLines: instance.consoleBufferLines
		},
		state: { active: summary.state.active, sub: summary.state.sub },
		running: summary.running,
		eulaAccepted: summary.eulaAccepted,
		iconVersion: summary.iconVersion,
		// The header's actions work from every tab, so what they need is here.
		countdown: getCountdown(instance.id),
		address: `${primaryLanAddress()}:${instance.serverPort}`,
		// Streamed: the first look opens every mod jar (0.2-0.7 s on a big pack), and every tab loads this.
		spark: hasSpark(instance.path).then((has) => (has ? { active: activeProfile(instance.id) !== null } : null)),
		// Public through playit.gg: what players type. Streamed, as it asks playit's API (kept 15 s).
		publicAddress: serverTunnel(instance.id) ? playitStatus().then((status) => publicAddress(instance.id, status)) : null,
		section: url.pathname.split('/')[3] ?? 'overview'
	};
};
