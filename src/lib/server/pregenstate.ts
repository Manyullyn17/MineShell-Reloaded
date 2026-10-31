/**
 * Which servers' Chunky had tasks running when last asked (`chunky progress`, chunky.ts): a
 * server the game paused for being empty goes on generating, and its header then says
 * Pre-generating instead of Paused (instances.ts). Asked whenever the World tab reads the
 * progress, right after each start, pause, continue and cancel, and, while a server is paused,
 * every 30 s by the scheduler; an answer older than that window is not trusted, so a server
 * that stopped being asked (running again, stopped) drops out on its own. Its own module
 * because chunky.ts imports instances.ts.
 */

const SEEN_FOR_MS = 90_000;
/**
 * A paused task ends after Chunky's current batch, on its own thread, and `chunky progress`
 * lists it until then: for this long after a pause or cancel, it is not counted as running.
 */
const STOPPING_MS = 15_000;

const seen = new Map<string, { at: number; worlds: Set<string> }>();
/** Per server, the dimensions paused or cancelled lately ('*' for all of them), and when. */
const stopped = new Map<string, Map<string, number>>();

const stopping = (instanceId: string, world: string, now: number) => {
	const recent = stopped.get(instanceId);
	return !!recent && [world, '*'].some((key) => now - (recent.get(key) ?? -Infinity) < STOPPING_MS);
};

/** The dimensions `chunky progress` just named as running for this server. */
export function notePregen(instanceId: string, worlds: string[]): void {
	const now = Date.now();
	const running = worlds.filter((world) => !stopping(instanceId, world, now));
	if (running.length) seen.set(instanceId, { at: now, worlds: new Set(running) });
	else seen.delete(instanceId);
}

/** A pause or cancel was just sent, for one dimension or (null) all of them. */
export function notePregenStopped(instanceId: string, world: string | null): void {
	const recent = stopped.get(instanceId) ?? new Map<string, number>();
	recent.set(world ?? '*', Date.now());
	stopped.set(instanceId, recent);
	const hit = seen.get(instanceId);
	if (hit) notePregen(instanceId, [...hit.worlds]);
}

/** A start or continue was just sent, for one dimension or (null) any: no longer stopping. */
export function notePregenStarted(instanceId: string, world: string | null): void {
	const recent = stopped.get(instanceId);
	if (!recent) return;
	recent.delete('*');
	if (world) recent.delete(world);
	else stopped.delete(instanceId);
}

export function pregenRunning(instanceId: string): boolean {
	const hit = seen.get(instanceId);
	return !!hit && Date.now() - hit.at < SEEN_FOR_MS;
}
