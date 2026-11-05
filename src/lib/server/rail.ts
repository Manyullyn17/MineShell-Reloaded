import { recentPlayerCount, summariseAll } from './instances';
import { gaveUpAfter } from '#lib/shared/format.js';

/** What the sidebar shows of each server: in every page's data, and read by itself (`/api/rail`). */
export function railInstances(summaries: Awaited<ReturnType<typeof summariseAll>>) {
	return Promise.all(
		summaries.map(async (s) => ({
			id: s.instance.id,
			name: s.instance.name,
			iconVersion: s.iconVersion,
			active: s.state.active,
			sub: s.state.sub,
			phase: s.phase,
			pinned: s.instance.pinned,
			status: s.instance.status,
			players: s.running ? await recentPlayerCount(s.instance) : null,
			gaveUpAfter: gaveUpAfter(s.state.active, s.state.result, s.instance.crashRestartLimit)
		}))
	);
}
