import { describe, expect, it } from 'vitest';
import { finishWatcher } from './taskwatch';

const task = (id: string, state: 'running' | 'done' | 'failed') => ({ id, state });

describe('finishWatcher', () => {
	it('reports a task that started and finished before the first payload', () => {
		// A snapshot of a small world, done before the stream connected: the page still reloads.
		const watch = finishWatcher(['old']);
		expect(watch([task('snap', 'done'), task('old', 'done')]).map((t) => t.id)).toEqual(['snap']);
	});

	it('leaves out what had finished when the page loaded', () => {
		expect(finishWatcher(['a', 'b'])([task('a', 'done'), task('b', 'failed')])).toEqual([]);
	});

	it('reports each task once, when it finishes', () => {
		const watch = finishWatcher([]);
		expect(watch([task('x', 'running')])).toEqual([]);
		expect(watch([task('x', 'failed')]).map((t) => t.id)).toEqual(['x']);
		// A reconnect sends the whole list again.
		expect(watch([task('x', 'failed')])).toEqual([]);
	});
});
