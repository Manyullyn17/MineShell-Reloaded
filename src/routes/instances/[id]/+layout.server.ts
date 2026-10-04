import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getInstance, summarise } from '#lib/server/instances.js';
import { LOADERS } from '#lib/server/modloaders.js';
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
			serverPort: instance.serverPort,
			status: instance.status,
			statusMessage: instance.statusMessage,
			pinned: instance.pinned,
			consoleBufferLines: instance.consoleBufferLines
		},
		state: { active: summary.state.active, sub: summary.state.sub },
		running: summary.running,
		eulaAccepted: summary.eulaAccepted,
		section: url.pathname.split('/')[3] ?? 'overview'
	};
};
