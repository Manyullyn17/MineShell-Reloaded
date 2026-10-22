import { EventEmitter } from 'node:events';

/**
 * One process-wide bus. Server-Sent Event endpoints subscribe to it rather than
 * each opening their own journalctl/systemctl process, so ten browser tabs cost
 * the same as one.
 */
export type BusEvents = {
	'console:line': { instanceId: string; line: string; ts: number };
	'stats:sample': { instanceId: string; cpuPercent: number; memoryBytes: number; ts: number };
	'instance:state': { instanceId: string; active: string; sub: string };
	'task:update': { id: string };
	/** A snapshot became one (snapshots.ts finishSnapshot): backups.ts copies it to the server's backup folder. */
	'snapshot:finished': { instanceId: string; snapshotId: string };
	/** Sessions, accounts or access changed (auth.ts, accounts.ts): open streams check again (access.ts guardStream). */
	'access:changed': { userId: string | null };
};

class TypedBus extends EventEmitter {
	publish<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
		this.emit(event as string, payload);
	}
	subscribe<K extends keyof BusEvents>(
		event: K,
		handler: (payload: BusEvents[K]) => void
	): () => void {
		this.on(event as string, handler as (p: unknown) => void);
		return () => this.off(event as string, handler as (p: unknown) => void);
	}
}

/**
 * Shared by every copy of this module: dev HMR re-evaluates it (and the ones
 * importing it), and streams opened on the old bus heard nothing published on
 * the new one - the notification center missed every task until a page reload.
 */
const globals = globalThis as { __mineshellBus?: TypedBus };
export const bus = (globals.__mineshellBus ??= new TypedBus());
bus.setMaxListeners(0);
