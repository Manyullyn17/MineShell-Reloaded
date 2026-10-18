import { describe, expect, it } from 'vitest';
import { cancelTask, getTask, listTasks, startTask } from './tasks';
import { bus } from './events';

// A second evaluation of a module, as dev HMR makes one: a query makes it a module of its own
// (ending in .ts, or Vite leaves the TypeScript untransformed).
const copyOf = <T>(spec: string): Promise<T> => import(/* @vite-ignore */ `${spec}?copy=${Math.random()}.ts`);

describe('module state across re-evaluations (dev HMR)', () => {
	it('a fresh copy of tasks.ts lists the tasks the old one started', async () => {
		let finish = () => {};
		const id = startTask({ label: 'Snapshot' }, () => new Promise<void>((resolve) => (finish = resolve)));
		const fresh = await copyOf<typeof import('./tasks')>('./tasks.ts');
		expect(fresh.listTasks().map((t) => t.id)).toContain(id);
		expect(fresh.getTask(id)).toBe(listTasks().find((t) => t.id === id));
		finish();
	});

	it('a stream subscribed on the old bus hears what a fresh copy publishes', async () => {
		const heard: string[] = [];
		const unsubscribe = bus.subscribe('task:update', ({ id }) => heard.push(id));
		const fresh = await copyOf<typeof import('./events')>('./events.ts');
		fresh.bus.publish('task:update', { id: 'after-reload' });
		unsubscribe();
		expect(heard).toEqual(['after-reload']);
	});
});

describe('cancelling', () => {
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	it('only stops work that said it can, and says what cancelling does', async () => {
		let finish = () => {};
		const stuck = startTask({ label: 'Install' }, () => new Promise<void>((resolve) => (finish = resolve)));
		expect(cancelTask(stuck)).toBeNull();
		expect(getTask(stuck)?.cancel).toBeNull();
		finish();

		let checked = false;
		const stoppable = startTask({ label: 'Analyse', cancel: 'Stops the analysis.' }, async (task) => {
			while (!task.isCancelled()) await settle();
			checked = true;
		});
		expect(cancelTask(stoppable)).toBe('Stops the analysis.');
		while (getTask(stoppable)?.state === 'running') await settle();
		expect(checked).toBe(true);
		expect(getTask(stoppable)).toMatchObject({ state: 'cancelled', step: 'Cancelled' });
		// Finished: nothing left to cancel.
		expect(cancelTask(stoppable)).toBeNull();
	});
});
