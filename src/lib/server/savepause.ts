/**
 * Servers whose saving MineShell has paused (save-off) while it copies their world: a
 * live snapshot, a world download, a server export. Anything else that would make the
 * server write its world meanwhile (worldrules.ts's save-all after a live change) asks
 * here first, as a write in the middle of the copy would leave it half old, half new.
 * In memory: a restart of MineShell ends every copy, and recovery turns saving back on.
 */
const paused = new Map<string, number>();

/** Marks saving paused for this server until the returned function is called (once is enough). */
export function holdSaving(instanceId: string): () => void {
	paused.set(instanceId, (paused.get(instanceId) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const left = (paused.get(instanceId) ?? 1) - 1;
		if (left > 0) paused.set(instanceId, left);
		else paused.delete(instanceId);
	};
}

export const savingPaused = (instanceId: string) => paused.has(instanceId);
