/**
 * Picks the tasks that finished while this page was open out of the task
 * stream's payloads, each once. `known` are the ones already finished when the
 * page loaded (from the layout's data, so the server's own view): those are
 * old news. Anything else finished counts, also in the stream's first payload:
 * a task can start and finish before the stream connects (a snapshot of a
 * small world takes milliseconds; a plain-http page waits for a free
 * connection while other tabs hold theirs), and treating that first payload as
 * old news left the page without its reload and the task without its toast.
 */
export function finishWatcher(known: Iterable<string>) {
	const seen = new Set(known);
	return <T extends { id: string; state: string }>(list: T[]): T[] => {
		const finished = list.filter((t) => t.state !== 'running' && !seen.has(t.id));
		for (const task of finished) seen.add(task.id);
		return finished;
	};
}
