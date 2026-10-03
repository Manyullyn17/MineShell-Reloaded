import type { ServerInstance } from './db/schema';
import { audit, getInstance, onlinePlayers, restart, sendCommand, stop, summarise } from './instances';

/**
 * Stop or restart after an in-game countdown, as scheduled restarts warn
 * before theirs. Kept in memory: a countdown MineShell's own restart cuts
 * short simply does not happen, which is the safe outcome for a stop.
 */

export type CountdownVerb = 'stop' | 'restart';
export type Countdown = { verb: CountdownVerb; at: number };

type Running = Countdown & { timers: NodeJS.Timeout[] };

const countdowns = new Map<string, Running>();

/** Warnings at these many seconds before, where the countdown is long enough. */
const MARKS = [15 * 60, 10 * 60, 5 * 60, 2 * 60, 60, 30, 10];

function describe(seconds: number): string {
	if (seconds >= 60) {
		const minutes = Math.round(seconds / 60);
		return `${minutes} minute${minutes === 1 ? '' : 's'}`;
	}
	return `${seconds} seconds`;
}

async function say(instance: ServerInstance, text: string): Promise<void> {
	await sendCommand(instance, `say ${text}`).catch(() => undefined);
}

export function getCountdown(instanceId: string): Countdown | null {
	const running = countdowns.get(instanceId);
	return running ? { verb: running.verb, at: running.at } : null;
}

export function cancelCountdown(instanceId: string): boolean {
	const running = countdowns.get(instanceId);
	if (!running) return false;
	for (const t of running.timers) clearTimeout(t);
	countdowns.delete(instanceId);
	const instance = getInstance(instanceId);
	if (instance) {
		void say(instance, `The ${running.verb === 'stop' ? 'shutdown' : 'restart'} was cancelled.`);
		audit('instance.countdown_cancelled', { instanceId, detail: running.verb });
	}
	return true;
}

/**
 * Warn players, then stop or restart. With nobody online there is no one to
 * warn, so it happens at once; the result says which.
 */
export async function startCountdown(
	instance: ServerInstance,
	verb: CountdownVerb,
	seconds: number
): Promise<{ ok: boolean; message: string }> {
	cancelCountdown(instance.id);
	const players = await onlinePlayers(instance).catch(() => null);
	if (players && players.online === 0) {
		const result = verb === 'stop' ? await stop(instance) : await restart(instance);
		return { ...result, message: `Nobody is online, so no countdown. ${result.message}` };
	}

	const at = Date.now() + seconds * 1000;
	const what = verb === 'stop' ? 'shutting down' : 'restarting';
	const timers: NodeJS.Timeout[] = [];
	for (const mark of MARKS.filter((m) => m < seconds)) {
		timers.push(setTimeout(() => void say(instance, `Server ${what} in ${describe(mark)}.`), (seconds - mark) * 1000));
	}
	timers.push(
		setTimeout(async () => {
			countdowns.delete(instance.id);
			const current = getInstance(instance.id);
			// Stopped in the meantime: a restart would start it again.
			if (!current || !(await summarise(current)).running) return;
			await say(current, `Server ${what} now.`);
			audit(`instance.countdown_${verb}`, { instanceId: instance.id });
			await (verb === 'stop' ? stop(current) : restart(current));
		}, seconds * 1000)
	);
	for (const t of timers) t.unref?.();
	countdowns.set(instance.id, { verb, at, timers });
	await say(instance, `Server ${what} in ${describe(seconds)}.`);
	return { ok: true, message: `${verb === 'stop' ? 'Stopping' : 'Restarting'} in ${describe(seconds)}; players were warned.` };
}
