import { afterEach, describe, expect, it, vi } from 'vitest';
import { ICON_BATCH, iconLoader, renderIcon } from './itemicon.svelte.js';

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

	it('gives no picture for a model that draws nothing (a mod\'s invisible placeholder)', async () => {
		// Just enough of a browser: images that load, canvases whose pixels are `alpha`.
		let alpha = 0;
		const context = new Proxy({} as Record<string, unknown>, {
			get: (_t, key) => (key === 'getImageData' ? () => ({ data: new Uint8ClampedArray(64 * 64 * 4).fill(alpha) }) : () => {})
		});
		vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => context, toDataURL: () => 'data:image/png;base64,x' }) });
		vi.stubGlobal(
			'Image',
			class {
				width = 16;
				height = 16;
				onload: (() => void) | null = null;
				set src(_v: string) {
					queueMicrotask(() => this.onload?.());
				}
			}
		);
		try {
			const spec = { kind: 'flat' as const, layers: [{ texture: 'bewitchment:blocks/nothing', tint: null }] };
			expect(await renderIcon(spec, (ref) => ref)).toBeNull();
			alpha = 255;
			expect(await renderIcon(spec, (ref) => ref)).toBe('data:image/png;base64,x');
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("takes a connected texture's first piece, not a strip of all of them (Rechiseled)", async () => {
		const canvases: { width: number; height: number }[] = [];
		const draws: number[][] = [];
		const context = new Proxy({} as Record<string, unknown>, {
			get: (_t, key) =>
				key === 'getImageData'
					? () => ({ data: new Uint8ClampedArray(64 * 64 * 4).fill(255) })
					: key === 'drawImage'
						? (...args: unknown[]) => draws.push(args.slice(1).map(Number))
						: () => {}
		});
		vi.stubGlobal('document', {
			createElement: () => {
				const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: () => 'data:,' };
				canvases.push(canvas);
				return canvas;
			}
		});
		vi.stubGlobal(
			'Image',
			class {
				width = 80;
				height = 16;
				onload: (() => void) | null = null;
				set src(_v: string) {
					queueMicrotask(() => this.onload?.());
				}
			}
		);
		try {
			await renderIcon({ kind: 'flat', layers: [{ texture: 'rechiseled:block/tiles', tint: null }] }, (ref) => ref);
			// The icon's own canvas, then the texture's: 16 square, from the strip's first 16x16.
			expect(canvases.map((c) => [c.width, c.height])).toEqual([[64, 64], [16, 16]]);
			expect(draws[0]).toEqual([0, 0, 16, 16, 0, 0, 16, 16]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
