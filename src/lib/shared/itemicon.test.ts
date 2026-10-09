import { afterEach, describe, expect, it, vi } from 'vitest';
import { ICON_BATCH, iconLoader } from './itemicon.svelte.js';

describe('icon loader', () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it('asks for a big inventory in batches the server answers whole', async () => {
		// The server answers the first ICON_BATCH of a request; everything after
		// went without an icon (a player with 450 ProjectE knowledge entries lost
		// their Baubles).
		const sizes: number[] = [];
		globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const { items } = JSON.parse(String(init?.body)) as { items: { id: string; damage: number | null }[] };
			sizes.push(items.length);
			const icons = Object.fromEntries(items.slice(0, ICON_BATCH).map((i) => [i.id, { spec: null, exact: true, name: `Name of ${i.id}` }]));
			return new Response(JSON.stringify({ icons, vanilla: true }));
		}) as typeof fetch;
		const loader = iconLoader('x');
		const all = await Promise.all(Array.from({ length: 1202 }, (_, i) => loader.icon(`mod:item_${i}`, null)));
		expect(sizes).toEqual([500, 500, 202]);
		expect(all.at(-1)?.name).toBe('Name of mod:item_1201');
	});
});
