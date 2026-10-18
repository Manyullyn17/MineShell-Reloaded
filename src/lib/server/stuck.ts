import { doneStartingAt } from './startphase';
import { notify } from './notifications';
import type { ServerInstance } from './db/schema';

/**
 * A server still not "Done (" this long after starting is probably hung
 * (crash diagnosis only covers runs that ended). MeatballCraft, the biggest
 * pack here, takes about 95 s; a first start that also generates the world
 * takes several times that.
 */
export const STUCK_AFTER_MS = 10 * 60_000;

export async function stuckStarting(instanceId: string, createdAt: number, startedAt: number): Promise<boolean> {
	if (!startedAt || Date.now() - startedAt < STUCK_AFTER_MS) return false;
	return (await doneStartingAt(instanceId, createdAt, startedAt)) === null;
}

/** The run (by start time) whose being stuck was reported, per server. */
const reported = new Map<string, number>();

/** From the scheduler's tick: reports a running server stuck starting, once per run. */
export async function notifyIfStuck(instance: ServerInstance, startedAt: number): Promise<void> {
	if (!startedAt || reported.get(instance.id) === startedAt) return;
	if (!(await stuckStarting(instance.id, instance.createdAt, startedAt))) return;
	reported.set(instance.id, startedAt);
	await notify({
		kind: 'stuck',
		instance: { id: instance.id, name: instance.name },
		title: 'Stuck starting',
		message: `Started ${Math.round((Date.now() - startedAt) / 60_000)} minutes ago and has not finished starting. Its console shows where it stopped.`,
		at: Date.now()
	});
}
