import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import { followKey } from './follow.svelte.js';

describe('followKey', () => {
	// The bug: the console's effect read its instanceId prop, which the page's data
	// gives it; every reload of the data (each 3 s while a server starts) ran the
	// effect again, emptying the view and reopening the stream.
	it('opens again only when the key changes, not when its source is reloaded', () => {
		let data = $state({ instance: { id: 'alpha' } });
		const calls: string[] = [];
		const stop = $effect.root(() => {
			followKey(
				() => data.instance.id,
				(id) => {
					calls.push(`open ${id}`);
					return () => calls.push(`close ${id}`);
				}
			);
		});
		flushSync();
		data = { instance: { id: 'alpha' } };
		flushSync();
		data = { instance: { id: 'alpha' } };
		flushSync();
		expect(calls).toEqual(['open alpha']);

		data = { instance: { id: 'beta' } };
		flushSync();
		expect(calls).toEqual(['open alpha', 'close alpha', 'open beta']);
		stop();
		expect(calls.at(-1)).toBe('close beta');
	});
});
