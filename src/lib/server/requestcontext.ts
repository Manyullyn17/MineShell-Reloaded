import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The account a request runs as, for code far from the request (audit() in an
 * operation started by it, maybe after a download finished). hooks.server.ts
 * runs every request inside `runAs`; work the request starts carries it along
 * (promises, timers, tasks), so an install is still the account's that asked
 * for it. Work MineShell starts itself (the scheduler, recovery) has none.
 */

export type Actor = { id: string; username: string };

const store = new AsyncLocalStorage<Actor | null>();

export function runAs<T>(actor: Actor | null, work: () => T): T {
	return store.run(actor, work);
}

/** The account the current work is for, or null for MineShell's own. */
export function currentActor(): Actor | null {
	return store.getStore() ?? null;
}
