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

export const bus = new TypedBus();
bus.setMaxListeners(0);
