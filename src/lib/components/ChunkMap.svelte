<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { fitToViewport } from '#lib/shared/fitToViewport.js';
	import { blockAt, chunkKey, chunkState, presence, readRegion, REGION, regionFile, type RegionDetail } from '#lib/shared/chunkmap.js';

	/**
	 * A flat map of one dimension to pick chunks on (World > Restore chunks).
	 * Every region in view gets its picture (top blocks, shaded by height),
	 * nearest the middle first: zoomed out a small one, so a whole world fills
	 * in, zoomed in the full one. Until then a region shows its chunks as grey
	 * squares. A chunk grid shows once chunks are
	 * big enough to see, region lines and coordinates at every zoom.
	 *
	 * Selection, like a minimap's claims: an accent fill, bordered on the
	 * selection's outer edge. Drag moves, the wheel or a pinch zooms, a click
	 * or tap toggles a chunk; Shift-drag adds a rectangle, Ctrl-drag removes
	 * one, and `selecting` (the page's Select button, for touch) makes a plain
	 * drag a rectangle.
	 *
	 * World > Prune chunks lays a colour per chunk over it (`layer`: the
	 * heatmap, the chunks that would go), with or without the terrain under it.
	 */
	let {
		overview,
		regionUrl,
		selected,
		center,
		selecting = false,
		jump = null,
		layer = null,
		circle = null,
		describe = null,
		tapHint = 'Tap a chunk to select it and see what is there.'
	}: {
		/** Region files and their chunks, from the overview endpoint. */
		overview: { x: number; z: number; chunks: string }[];
		/** Where one region's picture comes from; null draws no terrain. */
		regionUrl: ((x: number, z: number) => string) | null;
		selected: SvelteSet<string>;
		/** Block position shown first. */
		center: { x: number; z: number };
		selecting?: boolean;
		/** Set to move the view (the page's coordinate field); a new object each time. `zoom: false` keeps the zoom. */
		jump?: { x: number; z: number; zoom?: boolean } | null;
		/**
		 * A colour per chunk over the terrain: per region "x,z", a code per chunk
		 * index (x + 32 * z), 0 for none; `colours[code]` names its custom property.
		 * A new array for a region draws it again.
		 */
		layer?: { regions: Map<string, Uint8Array>; colours: string[]; alpha: number } | null;
		/** A circle in block coordinates (the radius pruning keeps around spawn), dashed. */
		circle?: { x: number; z: number; radius: number } | null;
		/** A line about a chunk for the tooltip. */
		describe?: ((cx: number, cz: number) => string | null) | null;
		/** Under the map on touch screens, before anything is tapped. */
		tapHint?: string;
	} = $props();

	const MIN_SCALE = 1 / 32;
	const MAX_SCALE = 16;
	/**
	 * From this many pixels per block (a region 128 pixels wide) full region
	 * pictures are fetched; below it the small ones (64x64, every eighth
	 * column), for every region in view: zoomed out, the whole world fills in.
	 */
	const DETAIL_SCALE = 1 / 4;
	/** Full pictures kept (about 2.3 MB each: the picture, and the columns for the tooltip). */
	const KEEP_DETAILS = 64;
	/**
	 * Regions in view drawn from full pictures at once, nearest the middle:
	 * fewer than are kept, so none in view is pushed out (more made them push
	 * each other out and load again, flickering). A 1440p screen shows ~45 at
	 * the zoom where full pictures start.
	 */
	const FULL_IN_VIEW = 56;
	const KEEP_SMALL = 6000;
	const PARALLEL = 3;

	let wrap: HTMLDivElement;
	let canvas: HTMLCanvasElement;
	let width = $state(0);
	let height = $state(0);

	// The view: block position in the middle, pixels per block.
	let viewX = untrack(() => center.x);
	let viewZ = untrack(() => center.z);
	let scale = 1 / 2;

	/** Overview per region "x,z": chunk presence, drawn into a 32x32 picture once. */
	type Summary = { present: Uint8Array; picture: HTMLCanvasElement };
	let summaries = new Map<string, Summary>();
	type Picture = { detail: RegionDetail; picture: HTMLCanvasElement };
	/** Region pictures by "x,z", most recently used last: full ones and the zoomed-out ones. */
	const details = new Map<string, Picture>();
	const small = new Map<string, Picture>();
	/** By "full:x,z" / "small:x,z". */
	const loading = new Set<string>();
	const failed = new Set<string>();
	let wanted: string[] = [];
	let generation = 0;

	// Hover (mouse) or last tap (touch): what is under it.
	let hoverCapable = $state(false);
	let pointer = $state<{ px: number; py: number; x: number; z: number } | null>(null);
	let tapped = $state<{ x: number; z: number } | null>(null);
	let tick = $state(0);
	const shown = $derived(hoverCapable ? pointer : tapped);
	const info = $derived.by(() => {
		void tick;
		if (!shown) return null;
		const cx = Math.floor(shown.x / 16);
		const cz = Math.floor(shown.z / 16);
		const at = `${Math.floor(shown.x / REGION)},${Math.floor(shown.z / REGION)}`;
		const region = details.get(at) ?? small.get(at);
		return {
			x: shown.x,
			z: shown.z,
			cx,
			cz,
			file: regionFile(cx, cz),
			top: region ? blockAt(region.detail, shown.x, shown.z) : null,
			state: region ? chunkState(region.detail, cx, cz) : null,
			note: describe?.(cx, cz) ?? null
		};
	});

	function summaryPicture(present: Uint8Array): HTMLCanvasElement {
		const picture = document.createElement('canvas');
		picture.width = picture.height = 32;
		const ctx = picture.getContext('2d')!;
		const image = ctx.createImageData(32, 32);
		for (let i = 0; i < 1024; i++) {
			if (!present[i]) continue;
			image.data.set([127, 135, 144, 150], i * 4);
		}
		ctx.putImageData(image, 0, 0);
		return picture;
	}

	// A new overview (another dimension or source): start over.
	$effect(() => {
		const next = new Map<string, Summary>();
		for (const r of overview) {
			const present = presence(r.chunks);
			next.set(`${r.x},${r.z}`, { present, picture: summaryPicture(present) });
		}
		untrack(() => {
			summaries = next;
			roofed = false;
			details.clear();
			small.clear();
			loading.clear();
			failed.clear();
			generation++;
			redraw();
		});
	});

	$effect(() => {
		if (!jump) return;
		viewX = jump.x;
		viewZ = jump.z;
		if (jump.zoom !== false) scale = Math.max(scale, 2);
		untrack(redraw);
	});

	/**
	 * Under a roof (the Nether's, a mod dimension's: regionColumns finds it) regions show
	 * what is below it; `surface` asks for the roof and what is built on it instead.
	 * The switch shows once a region with a roof has loaded.
	 */
	let surface = $state(false);
	let roofed = $state(false);
	function setSurface(on: boolean) {
		if (surface === on) return;
		surface = on;
		details.clear();
		small.clear();
		loading.clear();
		failed.clear();
		generation++;
		redraw();
	}

	// Turning the terrain or the layer on or off, or a new layer, redraws.
	$effect(() => {
		void regionUrl;
		void layer;
		void circle;
		untrack(redraw);
	});

	// Selection changes from outside (Clear) redraw too.
	$effect(() => {
		void selected.size;
		untrack(redraw);
	});

	// ---------------------------------------------------------- loading ---

	function pump() {
		while (loading.size < PARALLEL && wanted.length) {
			const key = wanted.shift()!;
			const [kind, at] = key.split(':');
			const store = kind === 'full' ? details : small;
			if (store.has(at) || loading.has(key) || failed.has(key)) continue;
			const [x, z] = at.split(',').map(Number);
			const gen = generation;
			loading.add(key);
			const url = regionUrl;
			if (!url) break;
			const view = surface ? '&view=surface' : '';
			fetch(kind === 'full' ? `${url(x, z)}${view}` : `${url(x, z)}&size=64${view}`)
				.then(async (res) => {
					if (gen !== generation) return;
					if (res.status === 204 || !res.ok) {
						failed.add(key);
						return;
					}
					const detail = readRegion(await res.arrayBuffer());
					if (gen !== generation) return;
					const picture = document.createElement('canvas');
					picture.width = picture.height = detail.size;
					picture.getContext('2d')!.putImageData(detail.image!, 0, 0);
					// Drawn into the canvas: the pixels need not be kept twice.
					detail.image = null;
					store.set(at, { detail, picture });
					if (detail.roof !== null) roofed = true;
					const keep = kind === 'full' ? KEEP_DETAILS : KEEP_SMALL;
					while (store.size > keep) store.delete(store.keys().next().value!);
					tick++;
					redraw();
				})
				.catch(() => failed.add(key))
				.finally(() => {
					if (gen === generation) loading.delete(key);
					pump();
				});
		}
	}

	// ---------------------------------------------------------- drawing ---

	let frame = 0;
	function redraw() {
		if (frame || !canvas) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			draw();
		});
	}

	const sx = (x: number) => (x - viewX) * scale + width / 2;
	const sz = (z: number) => (z - viewZ) * scale + height / 2;
	const wx = (px: number) => (px - width / 2) / scale + viewX;
	const wz = (py: number) => (py - height / 2) / scale + viewZ;

	function draw() {
		const ctx = canvas.getContext('2d');
		if (!ctx || !width || !height) return;
		const dpr = window.devicePixelRatio || 1;
		if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
		}
		const style = getComputedStyle(wrap);
		const colour = (name: string) => style.getPropertyValue(name).trim();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = colour('--bg-sunken');
		ctx.fillRect(0, 0, width, height);
		ctx.imageSmoothingEnabled = false;

		const rx0 = Math.floor(wx(0) / REGION);
		const rx1 = Math.floor(wx(width) / REGION);
		const rz0 = Math.floor(wz(0) / REGION);
		const rz1 = Math.floor(wz(height) / REGION);
		// Regions in view, nearest the middle first.
		const inView: { rx: number; rz: number; key: string; d: number }[] = [];
		for (let rz = rz0; rz <= rz1; rz++) {
			for (let rx = rx0; rx <= rx1; rx++) {
				const key = `${rx},${rz}`;
				if (!summaries.has(key)) continue;
				const dx = (rx + 0.5) * REGION - viewX;
				const dz = (rz + 0.5) * REGION - viewZ;
				inView.push({ rx, rz, key, d: dx * dx + dz * dz });
			}
		}
		inView.sort((a, b) => a.d - b.d);
		// Zoomed in, full pictures for as many as are kept, nearest the middle; the rest stay
		// small. More than are kept would push each other out and load again, over and over.
		const fullBudget = scale >= DETAIL_SCALE ? FULL_IN_VIEW : 0;
		const want: string[] = [];
		for (const [n, { rx, rz, key }] of inView.entries()) {
			const size = REGION * scale;
			const x = sx(rx * REGION);
			const z = sz(rz * REGION);
			const full = details.get(key);
			const lowRes = small.get(key);
			const wantsFull = n < fullBudget;
			const drawn = !regionUrl ? undefined : wantsFull ? (full ?? lowRes) : (lowRes ?? full);
			if (drawn) {
				// Most recently used last: kept the longest. A full picture outside the budget is
				// drawn while it is there but not kept for it.
				if (drawn === lowRes) (small.delete(key), small.set(key, lowRes));
				else if (wantsFull) (details.delete(key), details.set(key, full!));
				ctx.drawImage(drawn.picture, x, z, size, size);
				const chunk = (i: number) => ctx.fillRect(x + (i % 32) * 16 * scale, z + Math.floor(i / 32) * 16 * scale, 16 * scale, 16 * scale);
				ctx.fillStyle = 'rgba(127, 135, 144, 0.55)';
				for (const i of drawn.detail.unreadable) chunk(i);
				// Generated only partway: faint, so the region keeps the shape its placeholder had.
				ctx.fillStyle = 'rgba(127, 135, 144, 0.28)';
				for (const i of Object.keys(drawn.detail.bare)) chunk(Number(i));
			} else {
				ctx.drawImage(summaries.get(key)!.picture, x, z, size, size);
			}
			if (!regionUrl) continue;
			if (wantsFull && !full && !failed.has(`full:${key}`)) want.push(`full:${key}`);
			if (!wantsFull && !lowRes && !failed.has(`small:${key}`)) want.push(`small:${key}`);
		}
		wanted = want;
		pump();
		if (layer) drawLayer(ctx, inView, layer, style);
		if (circle) drawCircle(ctx, circle, colour('--text'));

		drawGrid(ctx, colour('--text'), colour('--text-muted'), colour('--bg-sunken'));
		drawSelection(ctx, colour('--accent'));
		drawHover(ctx, colour('--text'));
		if (drag?.rect) drawRect(ctx, colour('--accent'));
	}

	/** Layer pictures (32x32, a pixel a chunk), redrawn when the codes or the colours change. */
	const layerPictures = new WeakMap<Uint8Array, { colours: string; picture: HTMLCanvasElement }>();

	/** A colour property as red, green, blue, through the canvas (any CSS colour works). */
	function rgb(ctx: CanvasRenderingContext2D, value: string): [number, number, number] {
		ctx.fillStyle = '#000';
		ctx.fillStyle = value || '#8c8c8c';
		const hex = String(ctx.fillStyle);
		if (hex.startsWith('#')) return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
		const m = hex.match(/\d+(\.\d+)?/g)?.map(Number) ?? [140, 140, 140];
		return [m[0], m[1], m[2]];
	}

	function drawLayer(
		ctx: CanvasRenderingContext2D,
		inView: { rx: number; rz: number; key: string }[],
		over: NonNullable<typeof layer>,
		style: CSSStyleDeclaration
	) {
		const values = over.colours.map((name) => (name ? style.getPropertyValue(name).trim() : ''));
		const colourKey = values.join(';');
		const table = values.map((v) => (v ? rgb(ctx, v) : null));
		ctx.globalAlpha = over.alpha;
		for (const { rx, rz, key } of inView) {
			const codes = over.regions.get(key);
			if (!codes) continue;
			let cached = layerPictures.get(codes);
			if (!cached || cached.colours !== colourKey) {
				const picture = document.createElement('canvas');
				picture.width = picture.height = 32;
				const pctx = picture.getContext('2d')!;
				const image = pctx.createImageData(32, 32);
				for (let i = 0; i < 1024; i++) {
					const c = table[codes[i]];
					if (c) image.data.set([c[0], c[1], c[2], 255], i * 4);
				}
				pctx.putImageData(image, 0, 0);
				cached = { colours: colourKey, picture };
				layerPictures.set(codes, cached);
			}
			ctx.drawImage(cached.picture, sx(rx * REGION), sz(rz * REGION), REGION * scale, REGION * scale);
		}
		ctx.globalAlpha = 1;
	}

	function drawCircle(ctx: CanvasRenderingContext2D, c: NonNullable<typeof circle>, text: string) {
		if (c.radius <= 0) return;
		ctx.beginPath();
		ctx.arc(sx(c.x), sz(c.z), c.radius * scale, 0, Math.PI * 2);
		ctx.strokeStyle = text;
		ctx.globalAlpha = 0.85;
		ctx.lineWidth = 1.5;
		ctx.setLineDash([6, 4]);
		ctx.stroke();
		ctx.setLineDash([]);
		ctx.globalAlpha = 1;
	}

	function drawGrid(ctx: CanvasRenderingContext2D, text: string, muted: string, bg: string) {
		const line = (x0: number, z0: number, x1: number, z1: number) => {
			ctx.moveTo(x0, z0);
			ctx.lineTo(x1, z1);
		};
		const lines = (step: number) => {
			ctx.beginPath();
			for (let x = Math.ceil(wx(0) / step) * step; x <= wx(width); x += step) line(Math.round(sx(x)) + 0.5, 0, Math.round(sx(x)) + 0.5, height);
			for (let z = Math.ceil(wz(0) / step) * step; z <= wz(height); z += step) line(0, Math.round(sz(z)) + 0.5, width, Math.round(sz(z)) + 0.5);
			ctx.stroke();
		};
		ctx.lineWidth = 1;
		ctx.strokeStyle = text;
		// Chunk lines once a chunk is 8 pixels.
		if (16 * scale >= 8) {
			ctx.globalAlpha = Math.min(0.18, (16 * scale - 8) / 40 + 0.06);
			lines(16);
		}
		// Region lines fade in from 24 pixels apart: closer, they would hide the map.
		if (REGION * scale >= 24) {
			ctx.globalAlpha = Math.min(0.35, (REGION * scale - 24) / 80 + 0.08);
			lines(REGION);
		}
		// Coordinates along the top and left, every power of two that leaves 90 pixels between them.
		let step = 16;
		while (step * scale < 90) step *= 2;
		ctx.globalAlpha = 1;
		ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
		ctx.textBaseline = 'top';
		const label = (text: string, x: number, z: number) => {
			const w = ctx.measureText(text).width;
			ctx.fillStyle = bg;
			ctx.globalAlpha = 0.75;
			ctx.fillRect(x - 2, z - 1, w + 4, 14);
			ctx.globalAlpha = 1;
			ctx.fillStyle = muted;
			ctx.fillText(text, x, z);
		};
		for (let x = Math.ceil(wx(0) / step) * step; x <= wx(width); x += step) label(`x ${x}`, Math.round(sx(x)) + 3, 3);
		for (let z = Math.ceil(wz(0) / step) * step; z <= wz(height); z += step) if (sz(z) > 18) label(`z ${z}`, 3, Math.round(sz(z)) + 3);
	}

	function drawSelection(ctx: CanvasRenderingContext2D, accent: string) {
		if (!selected.size) return;
		const size = 16 * scale;
		const cx0 = Math.floor(wx(0) / 16) - 1;
		const cx1 = Math.floor(wx(width) / 16) + 1;
		const cz0 = Math.floor(wz(0) / 16) - 1;
		const cz1 = Math.floor(wz(height) / 16) + 1;
		ctx.fillStyle = accent;
		ctx.strokeStyle = accent;
		ctx.globalAlpha = 0.3;
		const edges = new Path2D();
		for (const key of selected) {
			const [cx, cz] = key.split(',').map(Number);
			if (cx < cx0 || cx > cx1 || cz < cz0 || cz > cz1) continue;
			const x = sx(cx * 16);
			const z = sz(cz * 16);
			ctx.fillRect(x, z, size, size);
			// Only the selection's outer edge: sides with no selected neighbour.
			if (!selected.has(chunkKey(cx, cz - 1))) (edges.moveTo(x, z), edges.lineTo(x + size, z));
			if (!selected.has(chunkKey(cx, cz + 1))) (edges.moveTo(x, z + size), edges.lineTo(x + size, z + size));
			if (!selected.has(chunkKey(cx - 1, cz))) (edges.moveTo(x, z), edges.lineTo(x, z + size));
			if (!selected.has(chunkKey(cx + 1, cz))) (edges.moveTo(x + size, z), edges.lineTo(x + size, z + size));
		}
		ctx.globalAlpha = 1;
		ctx.lineWidth = size >= 6 ? 2 : 1;
		ctx.stroke(edges);
		// Zoomed far out a chunk is a pixel or less: outline the regions holding selected chunks too.
		if (REGION * scale < 48) {
			const regions = new Set([...selected].map((k) => k.split(',').map((n) => Math.floor(Number(n) / 32)).join(',')));
			ctx.lineWidth = 1.5;
			for (const r of regions) {
				const [rx, rz] = r.split(',').map(Number);
				ctx.strokeRect(sx(rx * REGION), sz(rz * REGION), REGION * scale, REGION * scale);
			}
		}
	}

	function drawHover(ctx: CanvasRenderingContext2D, text: string) {
		if (!pointer || drag || 16 * scale < 4) return;
		const cx = Math.floor(pointer.x / 16);
		const cz = Math.floor(pointer.z / 16);
		ctx.strokeStyle = text;
		ctx.globalAlpha = 0.8;
		ctx.lineWidth = 1;
		ctx.strokeRect(Math.round(sx(cx * 16)) + 0.5, Math.round(sz(cz * 16)) + 0.5, Math.round(16 * scale), Math.round(16 * scale));
		ctx.globalAlpha = 1;
	}

	function drawRect(ctx: CanvasRenderingContext2D, accent: string) {
		const r = rectChunks();
		if (!r) return;
		const x = sx(r.cx0 * 16);
		const z = sz(r.cz0 * 16);
		const w = (r.cx1 - r.cx0 + 1) * 16 * scale;
		const h = (r.cz1 - r.cz0 + 1) * 16 * scale;
		ctx.globalAlpha = drag?.remove ? 0.12 : 0.22;
		ctx.fillStyle = accent;
		ctx.fillRect(x, z, w, h);
		ctx.globalAlpha = 1;
		ctx.strokeStyle = accent;
		ctx.setLineDash([5, 4]);
		ctx.lineWidth = 1.5;
		ctx.strokeRect(x, z, w, h);
		ctx.setLineDash([]);
	}

	// ------------------------------------------------------ interaction ---

	type Drag = { id: number; startX: number; startY: number; lastX: number; lastY: number; moved: boolean; rect: boolean; remove: boolean };
	let drag: Drag | null = null;
	const touches = new Map<number, { x: number; y: number }>();
	let pinch: { distance: number; midX: number; midY: number } | null = null;

	const local = (e: PointerEvent | WheelEvent) => {
		const box = canvas.getBoundingClientRect();
		return { px: e.clientX - box.left, py: e.clientY - box.top };
	};

	function rectChunks() {
		if (!drag?.rect) return null;
		const ax = Math.floor(wx(drag.startX) / 16);
		const az = Math.floor(wz(drag.startY) / 16);
		const bx = Math.floor(wx(drag.lastX) / 16);
		const bz = Math.floor(wz(drag.lastY) / 16);
		return { cx0: Math.min(ax, bx), cx1: Math.max(ax, bx), cz0: Math.min(az, bz), cz1: Math.max(az, bz) };
	}

	function onDown(e: PointerEvent) {
		if (e.button !== 0) return;
		canvas.focus();
		canvas.setPointerCapture(e.pointerId);
		const { px, py } = local(e);
		touches.set(e.pointerId, { x: px, y: py });
		if (touches.size === 2) {
			// A second finger: pinch instead of whatever the first started.
			drag = null;
			const [a, b] = [...touches.values()];
			pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
			redraw();
			return;
		}
		const rect = selecting || e.shiftKey || e.ctrlKey || e.metaKey;
		const startsOnSelected = selected.has(chunkKey(Math.floor(wx(px) / 16), Math.floor(wz(py) / 16)));
		drag = { id: e.pointerId, startX: px, startY: py, lastX: px, lastY: py, moved: false, rect, remove: e.ctrlKey || e.metaKey || (selecting && !e.shiftKey && startsOnSelected) };
	}

	function onMove(e: PointerEvent) {
		const { px, py } = local(e);
		if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: px, y: py });
		if (pinch && touches.size === 2) {
			const [a, b] = [...touches.values()];
			const distance = Math.hypot(a.x - b.x, a.y - b.y);
			const midX = (a.x + b.x) / 2;
			const midY = (a.y + b.y) / 2;
			zoomAt(pinch.midX, pinch.midY, distance / pinch.distance);
			viewX -= (midX - pinch.midX) / scale;
			viewZ -= (midY - pinch.midY) / scale;
			pinch = { distance, midX, midY };
			redraw();
			return;
		}
		if (hoverCapable && e.pointerType === 'mouse') pointer = { px, py, x: Math.floor(wx(px)), z: Math.floor(wz(py)) };
		if (drag && drag.id === e.pointerId) {
			if (Math.hypot(px - drag.startX, py - drag.startY) > 4) drag.moved = true;
			if (!drag.rect && drag.moved) {
				viewX -= (px - drag.lastX) / scale;
				viewZ -= (py - drag.lastY) / scale;
			}
			drag.lastX = px;
			drag.lastY = py;
		}
		redraw();
	}

	function onUp(e: PointerEvent) {
		touches.delete(e.pointerId);
		if (pinch) {
			if (touches.size < 2) pinch = null;
			drag = null;
			return;
		}
		if (!drag || drag.id !== e.pointerId) return;
		const { px, py } = local(e);
		if (!drag.moved) {
			// A click or tap: that chunk in or out.
			const key = chunkKey(Math.floor(wx(px) / 16), Math.floor(wz(py) / 16));
			if (selected.has(key)) selected.delete(key);
			else selected.add(key);
			if (!hoverCapable) tapped = { x: Math.floor(wx(px)), z: Math.floor(wz(py)) };
		} else if (drag.rect) {
			const r = rectChunks()!;
			for (let cz = r.cz0; cz <= r.cz1; cz++) {
				for (let cx = r.cx0; cx <= r.cx1; cx++) {
					if (drag.remove) selected.delete(chunkKey(cx, cz));
					else selected.add(chunkKey(cx, cz));
				}
			}
		}
		drag = null;
		redraw();
	}

	function zoomAt(px: number, py: number, factor: number) {
		const x = wx(px);
		const z = wz(py);
		scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
		viewX = x - (px - width / 2) / scale;
		viewZ = z - (py - height / 2) / scale;
	}

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		const { px, py } = local(e);
		zoomAt(px, py, Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1)));
		if (pointer) pointer = { px, py, x: Math.floor(wx(px)), z: Math.floor(wz(py)) };
		redraw();
	}

	function onKey(e: KeyboardEvent) {
		const step = 80 / scale;
		const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
		if (moves[e.key]) {
			viewX += moves[e.key][0];
			viewZ += moves[e.key][1];
		} else if (e.key === '+' || e.key === '=') zoomAt(width / 2, height / 2, 1.5);
		else if (e.key === '-') zoomAt(width / 2, height / 2, 1 / 1.5);
		else return;
		e.preventDefault();
		redraw();
	}

	export function zoom(factor: number) {
		zoomAt(width / 2, height / 2, factor);
		redraw();
	}

	onMount(() => {
		hoverCapable = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
		// The wheel must be able to stop the page scrolling: not passive.
		canvas.addEventListener('wheel', onWheel, { passive: false });
		const observer = new ResizeObserver(() => {
			width = wrap.clientWidth;
			height = wrap.clientHeight;
			redraw();
		});
		observer.observe(wrap);
		// The theme can change under the page: colours are read while drawing.
		const scheme = window.matchMedia('(prefers-color-scheme: dark)');
		scheme.addEventListener('change', redraw);
		return () => {
			canvas.removeEventListener('wheel', onWheel);
			observer.disconnect();
			scheme.removeEventListener('change', redraw);
			cancelAnimationFrame(frame);
		};
	});
</script>

<div class="chunk-map" bind:this={wrap} use:fitToViewport={{ bottomMarginPx: 24, maxViewportFraction: 0.75 }}>
	<canvas
		bind:this={canvas}
		tabindex="0"
		aria-label="Map of the dimension: arrow keys move, plus and minus zoom"
		onkeydown={onKey}
		onpointerdown={onDown}
		onpointermove={onMove}
		onpointerup={onUp}
		onpointercancel={onUp}
		onpointerleave={() => {
			pointer = null;
			redraw();
		}}
	></canvas>
	{#if roofed && regionUrl}
		<div class="roof" role="group" aria-label="Under a roof">
			<button type="button" class="button-quiet" aria-pressed={!surface} class:on={!surface} onclick={() => setSurface(false)}>Below the roof</button>
			<button type="button" class="button-quiet" aria-pressed={surface} class:on={surface} onclick={() => setSurface(true)}>Roof surface</button>
		</div>
	{/if}
	<div class="zoom">
		<button type="button" class="button-quiet" aria-label="Zoom in" onclick={() => zoom(1.6)}>+</button>
		<button type="button" class="button-quiet" aria-label="Zoom out" onclick={() => zoom(1 / 1.6)}>−</button>
	</div>
	{#if hoverCapable && info && pointer}
		<div class="tip" style:left="{Math.min(pointer.px + 14, width - 230)}px" style:top="{Math.min(pointer.py + 14, height - 90)}px">
			{#if info.top}<div class="top">{info.top.name} <span class="faint">y {info.top.y}</span></div>{/if}
			{#if info.state}<div class="muted-line">{info.state}</div>{/if}
			{#if info.note}<div>{info.note}</div>{/if}
			<div class="mono">x {info.x}, z {info.z}</div>
			<div class="mono faint">chunk {info.cx}, {info.cz} · {info.file}</div>
		</div>
	{/if}
</div>
{#if !hoverCapable}
	<p class="readout small" aria-live="polite">
		{#if info}
			{#if info.top}<strong>{info.top.name}</strong> <span class="faint">y {info.top.y}</span> ·{/if}
			{#if info.state}{info.state} ·{/if}
			{#if info.note}{info.note} ·{/if}
			<span class="mono">x {info.x}, z {info.z} · chunk {info.cx}, {info.cz} · {info.file}</span>
		{:else}
			<span class="faint">{tapHint}</span>
		{/if}
	</p>
{/if}

<style>
	.chunk-map {
		position: relative;
		height: 70vh;
		min-height: 18rem;
		border: 1px solid var(--line);
		border-radius: var(--radius, 4px);
		overflow: hidden;
		background: var(--bg-sunken);
	}

	canvas {
		display: block;
		width: 100%;
		height: 100%;
		cursor: grab;
		touch-action: none;
	}

	canvas:active {
		cursor: grabbing;
	}

	canvas:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.zoom {
		position: absolute;
		right: 0.5rem;
		bottom: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.roof {
		position: absolute;
		left: 0.5rem;
		bottom: 0.5rem;
		display: flex;
		gap: 2px;
	}

	.roof button {
		padding: 0.2rem 0.55rem;
		background: var(--panel);
		border: 1px solid var(--line-strong);
		font-size: 0.8rem;
	}

	.roof button.on {
		color: var(--accent-contrast);
		background: var(--accent);
		border-color: var(--accent);
	}

	.zoom button {
		width: 2rem;
		height: 2rem;
		padding: 0;
		background: var(--panel);
		border: 1px solid var(--line-strong);
		font-size: 1.1rem;
		line-height: 1;
	}

	.tip {
		position: absolute;
		pointer-events: none;
		max-width: 220px;
		padding: 0.35rem 0.55rem;
		background: var(--panel-raised);
		border: 1px solid var(--line-strong);
		border-radius: 4px;
		font-size: 0.8rem;
		line-height: 1.35;
		box-shadow: 0 2px 8px rgb(0 0 0 / 0.25);
	}

	.top {
		font-weight: 600;
	}

	.muted-line {
		color: var(--text-muted);
	}

	.faint {
		color: var(--text-faint);
		font-weight: 400;
	}

	.mono {
		font-family: var(--font-mono);
	}

	.readout {
		margin: 0.4rem 0 0;
		max-width: none;
		min-height: 1.4em;
		overflow-wrap: anywhere;
	}
</style>
