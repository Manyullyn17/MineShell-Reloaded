/**
 * Which servers' Chunky had a task running when last asked (`chunky progress`, chunky.ts):
 * a server the game paused for being empty goes on generating, and its header then says
 * Pre-generating instead of Paused (instances.ts). Asked whenever the World tab reads the
 * progress and, while a server is paused, every 30 s by the scheduler; an answer older than
 * that window is not trusted, so a server that stopped being asked (running again, stopped)
 * drops out on its own. Its own module because chunky.ts imports instances.ts.
 */

const SEEN_FOR_MS = 90_000;
const seen = new Map<string, number>();

/** What `chunky progress` just said for this server. */
export function notePregen(instanceId: string, running: boolean): void {
	if (running) seen.set(instanceId, Date.now());
	else seen.delete(instanceId);
}

export function pregenRunning(instanceId: string): boolean {
	const at = seen.get(instanceId);
	return at !== undefined && Date.now() - at < SEEN_FOR_MS;
}
