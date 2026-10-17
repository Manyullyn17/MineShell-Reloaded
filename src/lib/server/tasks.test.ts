import { describe, expect, it } from 'vitest';
import { listTasks, startTask } from './tasks';
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
