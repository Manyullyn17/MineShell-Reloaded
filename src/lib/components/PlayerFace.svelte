<script lang="ts" module>
	/** Faces drawn so far, by texture id: an 8x8 picture each, or null when the skin did not load. */
	const faces = new Map<string, Promise<ImageData | null>>();

	/**
	 * The face as the game shows it: the face layer (8,8) opaque, the hat layer
	 * (40,8) over it. An old 64x32 skin whose hat area (32..64 x 0..32) has no
	 * transparent pixel gets no hat: the game's "Notch transparency hack" (old
	 * skins filled that area, Notch's with black).
	 */
	function face(skin: string): Promise<ImageData | null> {
		let found = faces.get(skin);
		if (!found) {
			found = new Promise((resolve) => {
				const image = new Image();
				image.onload = () => {
					const canvas = document.createElement('canvas');
					canvas.width = 64;
					canvas.height = image.height === 32 ? 32 : 64;
					const ctx = canvas.getContext('2d', { willReadFrequently: true });
					if (!ctx) return resolve(null);
					ctx.drawImage(image, 0, 0);
					const pixels = ctx.getImageData(0, 0, 64, canvas.height).data;
					const at = (x: number, y: number) => (y * 64 + x) * 4;
					let hat = true;
					if (canvas.height === 32) {
						hat = false;
						for (let y = 0; y < 32 && !hat; y++) for (let x = 32; x < 64 && !hat; x++) hat = pixels[at(x, y) + 3] < 128;
					}
					const out = new ImageData(8, 8);
					for (let y = 0; y < 8; y++) {
						for (let x = 0; x < 8; x++) {
							const o = (y * 8 + x) * 4;
							const base = at(8 + x, 8 + y);
							const top = at(40 + x, 8 + y);
							const alpha = hat ? pixels[top + 3] / 255 : 0;
							for (let c = 0; c < 3; c++) out.data[o + c] = Math.round(pixels[top + c] * alpha + pixels[base + c] * (1 - alpha));
							out.data[o + 3] = 255;
						}
					}
					resolve(out);
				};
				image.onerror = () => resolve(null);
				image.src = `/api/skins/${skin}`;
			});
			faces.set(skin, found);
		}
		return found;
	}
</script>

<script lang="ts">
	import { locatorColor } from '#lib/shared/locatorcolor.js';

	/**
	 * A player's face from their skin, or a square in the colour the game's
	 * locator bar gives them (also while the skin loads, or when it does not).
	 * `id` is the UUID when known, else the name (the game colours a name-only
	 * waypoint by name).
	 */
	let { id, skin, size = 26 }: { id: string; skin: string | null; size?: number } = $props();
	let canvas = $state<HTMLCanvasElement | null>(null);
	let drawn = $state(false);

	$effect(() => {
		const target = canvas;
		drawn = false;
		if (!skin || !target) return;
		let live = true;
		void face(skin).then((pixels) => {
			if (!live || !pixels) return;
			target.getContext('2d')?.putImageData(pixels, 0, 0);
			drawn = true;
		});
		return () => {
			live = false;
		};
	});
</script>

<span class="face" style="--size: {size}px; background: {locatorColor(id)}" aria-hidden="true">
	{#if skin}<canvas bind:this={canvas} width="8" height="8" class:drawn></canvas>{/if}
</span>

<style>
	.face {
		display: inline-block;
		flex: none;
		width: var(--size);
		height: var(--size);
		border-radius: 3px;
		overflow: hidden;
	}

	canvas {
		display: block;
		width: 100%;
		height: 100%;
		image-rendering: pixelated;
		visibility: hidden;
	}

	canvas.drawn {
		visibility: visible;
	}
</style>
