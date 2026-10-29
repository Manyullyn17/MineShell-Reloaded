import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { bus } from './events';
import type { BlockedDownload } from '#lib/shared/downloads.js';

/**
 * Installing a 300-mod pack takes minutes. Rather than holding an HTTP request
 * open, long work is registered here and the UI follows along over SSE. Tasks
 * live in memory only: if MineShell restarts mid-install the instance is left
 * marked `failed` and can be retried, which is simpler than resuming.
 */

export type TaskState = 'running' | 'done' | 'failed' | 'cancelled';

export type Task = {
	id: string;
	label: string;
	instanceId: string | null;
	state: TaskState;
	/** 0-100, or null when the total is not known yet. */
	progress: number | null;
	step: string;
	log: string[];
	error: string | null;
	/** Downloads refused while it ran (downloadaccess.ts), one per address: Activity asks to allow them. */
	blocked: BlockedDownload[];
	startedAt: number;
	finishedAt: number | null;
	/** What cancelling does, for the ones whose work stops when asked; null: no Cancel. */
	cancel: string | null;
};

/**
 * Shared by every copy of this module: dev HMR re-evaluates it, and the layout
 * and the task stream then each read their own list (the stream never saw a
 * task started after a reload of the code).
 */
const globals = globalThis as { __mineshellTasks?: { tasks: Map<string, Task>; cancelled: Set<string> } };
const shared = (globals.__mineshellTasks ??= { tasks: new Map(), cancelled: new Set() });
const tasks = shared.tasks;
const MAX_LOG_LINES = 400;
const KEEP_FINISHED_MS = 30 * 60_000;

export type TaskHandle = {
	id: string;
	setProgress: (percent: number | null, step?: string) => void;
	log: (line: string) => void;
	isCancelled: () => boolean;
	/**
	 * Past the point where cancelling can undo the work (a change committed): Cancel goes
	 * from the task, and one asked for just before is dropped, so the task ends as done.
	 * Returns whether one had been asked for, for the log to say it came too late.
	 */
	closeCancel: () => boolean;
};

const cancelled = shared.cancelled;

/** The task the current work belongs to, through awaits and timers. */
const current = new AsyncLocalStorage<Task>();

/** Records a refused download on the task running it, if any. */
export function noteBlockedDownload(blocked: BlockedDownload): void {
	const task = current.getStore();
	if (!task || task.blocked.some((b) => b.address === blocked.address)) return;
	task.blocked.push(blocked);
	touch(task);
}

export function listTasks(): Task[] {
	return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function getTask(id: string): Task | undefined {
	return tasks.get(id);
}

/** Asks a running task to stop; what that does, or null when it cannot be cancelled (or is not running). */
export function cancelTask(id: string): string | null {
	const task = tasks.get(id);
	if (task?.state !== 'running' || !task.cancel) return null;
	cancelled.add(id);
	return task.cancel;
}

function touch(task: Task) {
	tasks.set(task.id, task);
	bus.publish('task:update', { id: task.id });
}

function sweep() {
	const cutoff = Date.now() - KEEP_FINISHED_MS;
	for (const [id, task] of tasks) {
		if (task.finishedAt && task.finishedAt < cutoff) {
			tasks.delete(id);
			cancelled.delete(id);
		}
	}
}

/**
 * Starts `work` immediately and returns the task id. The promise is intentionally
 * not awaited by callers - they get the id and redirect to a progress view.
 */
export function startTask(
	opts: {
		label: string;
		instanceId?: string | null;
		/**
		 * Set for work that checks isCancelled() and stops: what cancelling does, said to whoever
		 * cancels. Without it there is no Cancel (most work cannot stop halfway).
		 */
		cancel?: string;
	},
	work: (handle: TaskHandle) => Promise<void>
): string {
	sweep();
	const id = crypto.randomUUID();
	const task: Task = {
		id,
		label: opts.label,
		instanceId: opts.instanceId ?? null,
		state: 'running',
		progress: null,
		step: 'Starting',
		log: [],
		error: null,
		blocked: [],
		startedAt: Date.now(),
		finishedAt: null,
		cancel: opts.cancel ?? null
	};
	touch(task);

	const handle: TaskHandle = {
		id,
		setProgress(percent, step) {
			task.progress = percent === null ? null : Math.max(0, Math.min(100, Math.round(percent)));
			if (step) task.step = step;
			touch(task);
		},
		log(line) {
			task.log.push(line);
			if (task.log.length > MAX_LOG_LINES) task.log.shift();
			touch(task);
		},
		isCancelled: () => cancelled.has(id),
		closeCancel() {
			const asked = cancelled.delete(id);
			if (task.cancel) {
				task.cancel = null;
				touch(task);
			}
			return asked;
		}
	};

	current
		.run(task, () => work(handle))
		.then(() => {
			task.state = cancelled.has(id) ? 'cancelled' : 'done';
			task.progress = task.state === 'done' ? 100 : task.progress;
			task.step = task.state === 'done' ? 'Finished' : 'Cancelled';
			task.finishedAt = Date.now();
			touch(task);
		})
		.catch((err: unknown) => {
			task.state = 'failed';
			task.error = err instanceof Error ? err.message : String(err);
			task.step = 'Failed';
			task.finishedAt = Date.now();
			task.log.push(`error: ${task.error}`);
			touch(task);
		});

	return id;
}
