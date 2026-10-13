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
};

const tasks = new Map<string, Task>();
const MAX_LOG_LINES = 400;
const KEEP_FINISHED_MS = 30 * 60_000;

export type TaskHandle = {
	id: string;
	setProgress: (percent: number | null, step?: string) => void;
	log: (line: string) => void;
	isCancelled: () => boolean;
};

const cancelled = new Set<string>();

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

export function cancelTask(id: string): void {
	if (tasks.get(id)?.state === 'running') cancelled.add(id);
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
	opts: { label: string; instanceId?: string | null },
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
		finishedAt: null
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
		isCancelled: () => cancelled.has(id)
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
