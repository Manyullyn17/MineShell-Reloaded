<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { enhance } from '#lib/shared/forms.js';
	import ChunkMap from '#lib/components/ChunkMap.svelte';
	import SegmentedChoice from '#lib/components/SegmentedChoice.svelte';
	import { formatBytes } from '#lib/shared/format.js';
	import { regionGeneration } from '#lib/shared/chunkmap.js';
	import {
		chunkInSelection,
		chunkyShape,
		existingInSelection,
		isRound,
		radii,
		rowRange,
		selectionChunks,
		selectionRows,
		twoRadii,
		type PregenShape,
		type RegionGeneration
	} from '#lib/shared/pregen.js';

	/**
	 * World > Pre-generate's selection: a dimension, a shape, its middle (typed,
	 * taken from spawn or the world border, or clicked on the map) and its
	 * radius, drawn on the chunk map with the chunks already there greyed:
	 * Chunky skips those, so the count of new ones is the work it has to do.
	 */
	type PregenDimension = {
		id: string;
		label: string;
		/** The folder the chunk map reads; null before anything was generated there. */
		key: string | null;
		spawn: { x: number; z: number } | null;
		border: { x: number; z: number; radius: number } | null;
	};
	let {
		instanceId,
		dimensions,
		running,
		generating = []
	}: {
		instanceId: string;
		dimensions: PregenDimension[];
		running: boolean;
		/** Dimensions Chunky is generating now: their map is read again every little while. */
		generating?: string[];
	} = $props();

	const id = $derived(encodeURIComponent(instanceId));
	const SHAPES: { value: PregenShape; label: string }[] = [
		{ value: 'square', label: 'Square' },
		{ value: 'rectangle', label: 'Rectangle' },
		{ value: 'circle', label: 'Circle' },
		{ value: 'ellipse', label: 'Ellipse' }
	];
	const PRESETS = [500, 1000, 2500, 5000, 10000];

	let world = $state(untrack(() => dimensions[0]?.id ?? 'minecraft:overworld'));
	let customWorld = $state('');
	const current = $derived(dimensions.find((d) => d.id === world) ?? null);
	let shape = $state<PregenShape>('square');
	const start = untrack(() => dimensions[0]?.spawn ?? { x: 0, z: 0 });
	let x = $state(start.x);
	let z = $state(start.z);
	let radius = $state(2500);
	let radiusZ = $state(2500);

	/** The selection as Chunky gets it; typed fields can be blank or odd while being edited. */
	const selection = $derived({
		shape,
		x: Number.isFinite(Number(x)) ? Math.round(Number(x)) : 0,
		z: Number.isFinite(Number(z)) ? Math.round(Number(z)) : 0,
		radius: Math.max(0, Number(radius) || 0),
		radiusZ: Math.max(0, Number(radiusZ) || 0)
	});
	const [rx, rz] = $derived(radii(selection));

	// The map moves to fit the selection when it is placed from a button, never while typing.
	let jump = $state<{ x: number; z: number; span: number } | null>(null);
	const fit = () => (jump = { x: selection.x, z: selection.z, span: 2.4 * Math.max(rx, rz, 64) });
	// And once on opening, to show the whole of it.
	$effect(() => {
		untrack(fit);
	});

	function moveTo(to: { x: number; z: number }) {
		x = to.x;
		z = to.z;
		fit();
	}
	function useBorder(border: { x: number; z: number; radius: number }) {
		shape = 'square';
		radius = radiusZ = border.radius;
		moveTo(border);
	}
	function useRadius(r: number) {
		radius = radiusZ = r;
		fit();
	}
	// Another dimension starts at its spawn, or 0, 0.
	let placedFor = untrack(() => world);
	$effect(() => {
		if (world === placedFor) return;
		placedFor = world;
		untrack(() => moveTo(current?.spawn ?? { x: 0, z: 0 }));
	});

	// The chunks that are there: the overview of the dimension's folder; then, for the regions the
	// selection reaches, which of them are fully generated (the region's chunk map data says).
	let overview = $state<{ x: number; z: number; chunks: string; bytes: number }[]>([]);
	let overviewState = $state<'none' | 'loading' | 'ready' | 'failed'>('none');
	const generation = new SvelteMap<string, RegionGeneration>();
	/** Regions asked for in this dimension, answered or not: each once. */
	let asked = new Set<string>();
	// By the folder's name, not the dimension's entry: the page's data reloads every few seconds
	// while Chunky runs, with new entries that are the same, and that must not start the map over.
	const currentKey = $derived(current?.key ?? null);
	function readOverview(key: string, isStale: () => boolean) {
		return fetch(`/api/instances/${id}/chunkmap?dimension=${encodeURIComponent(key)}&source=live`)
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
			.then((body: { regions: typeof overview }) => {
				if (isStale()) return;
				// A region that changed is checked again; the map reads its picture again too.
				const before = new Map(overview.map((r) => [`${r.x},${r.z}`, `${r.chunks}:${r.bytes}`]));
				for (const r of body.regions) {
					const region = `${r.x},${r.z}`;
					if (before.get(region) !== `${r.chunks}:${r.bytes}`) {
						generation.delete(region);
						asked.delete(region);
					}
				}
				overview = body.regions;
				overviewState = 'ready';
			});
	}
	$effect(() => {
		const key = currentKey;
		untrack(() => {
			overview = [];
			generation.clear();
			asked = new Set();
		});
		if (!key) {
			overviewState = 'none';
			return;
		}
		let stale = false;
		overviewState = 'loading';
		readOverview(key, () => stale).catch(() => {
			if (!stale) overviewState = 'failed';
		});
		return () => (stale = true);
	});
	// While Chunky generates this dimension, what it has done shows as it goes.
	const live = $derived(!!current && generating.includes(current.id));
	$effect(() => {
		const key = currentKey;
		if (!live || !key) return;
		let stale = false;
		const timer = setInterval(() => void readOverview(key, () => stale).catch(() => undefined), 20_000);
		return () => {
			stale = true;
			clearInterval(timer);
		};
	});
	const regionUrl = $derived.by(() => {
		const key = currentKey;
		return key ? (rgnX: number, rgnZ: number) => `/api/instances/${id}/chunkmap/region?dimension=${encodeURIComponent(key)}&source=live&x=${rgnX}&z=${rgnZ}` : null;
	});

	const total = $derived(selectionChunks(selection));
	const there = $derived(existingInSelection(selection, overview, generation));
	const fresh = $derived(total - there.existing - there.unchecked);
	/** Bytes per chunk from what the dimension holds; too few chunks say little. */
	const estimate = $derived(there.bytesPerChunk && there.known >= 256 ? fresh * there.bytesPerChunk : null);

	// Regions still to check, a few at a time once the selection has settled. The zoomed-out
	// picture is the smallest answer that carries it, and warms the map's own cache.
	$effect(() => {
		const key = currentKey;
		const wanted = there.toCheck.filter((r) => !asked.has(r));
		if (!key || !wanted.length) return;
		let stale = false;
		const timer = setTimeout(async () => {
			const next = async (): Promise<void> => {
				const region = wanted.shift();
				if (!region || stale) return;
				asked.add(region);
				const [rgnX, rgnZ] = region.split(',');
				try {
					const res = await fetch(`/api/instances/${id}/chunkmap/region?dimension=${encodeURIComponent(key)}&source=live&x=${rgnX}&z=${rgnZ}&size=64`);
					// No picture (204): nothing readable in it; its chunks count as not generated.
					const gen = res.status === 204 ? { notFull: [...Array(1024).keys()], unreadable: [] } : regionGeneration(await res.arrayBuffer());
					// Kept even when the selection moved on meanwhile (each answer re-runs this): only another dimension drops it.
					if (currentKey === key) generation.set(region, gen);
				} catch {
					asked.delete(region);
				}
				return next();
			};
			await Promise.all([next(), next(), next()]);
		}, 300);
		return () => {
			stale = true;
			clearTimeout(timer);
		};
	});
	const rows = $derived.by(() => {
		const span = selectionRows(selection);
		const sel = selection;
		return span ? { first: span[0], last: span[1], range: (cz: number) => rowRange(sel, cz) } : null;
	});
	// Chunky's own shape, put on chunks: zoomed out it is drawn as is, closer chunk by chunk.
	const area = $derived({ ...chunkyShape(selection), round: isRound(shape), rows });
	const layer = $derived({ regions: there.regions, colours: ['', '--text-faint'], alpha: 0.7 });
	const describe = (cx: number, cz: number) => {
		if (!chunkInSelection(selection, cx, cz)) return null;
		return there.regions.get(`${Math.floor(cx / 32)},${Math.floor(cz / 32)}`)?.[(cx & 31) + 32 * (cz & 31)]
			? 'Fully generated already: Chunky leaves it'
			: 'Chunky generates it';
	};
	const noSelection = new SvelteSet<string>();
	const otherWorld = $derived(world === 'other');
</script>

<form method="POST" action="?/chunkyStart" use:enhance={() => async ({ update }) => update({ reset: false })} class="planner">
	<div class="fields">
		<div class="field">
			<label for="pregen-world">Dimension</label>
			<select id="pregen-world" name="world" bind:value={world}>
				{#each dimensions as d (d.id)}
					<option value={d.id}>{d.label}</option>
				{/each}
				<option value="other">Another (type its id)</option>
			</select>
		</div>
		{#if otherWorld}
			<div class="field">
				<label for="pregen-custom">Dimension id</label>
				<input id="pregen-custom" name="customWorld" class="mono" bind:value={customWorld} placeholder="twilightforest:twilight_forest" required />
			</div>
		{/if}
		<div class="field">
			<span class="label" id="pregen-shape-label">Shape</span>
			<SegmentedChoice options={SHAPES} bind:value={shape} name="shape" labelledby="pregen-shape-label" />
		</div>
	</div>

	<div class="fields">
		<div class="field narrow">
			<label for="pregen-x">Center X</label>
			<input id="pregen-x" name="centerX" type="number" step="1" bind:value={x} required />
		</div>
		<div class="field narrow">
			<label for="pregen-z">Center Z</label>
			<input id="pregen-z" name="centerZ" type="number" step="1" bind:value={z} required />
		</div>
		<div class="field">
			<span class="label">Center on</span>
			<div class="row">
				{#if current?.spawn}
					<button type="button" class="button-quiet" onclick={() => moveTo(current.spawn!)}>Spawn</button>
				{/if}
				{#if current?.border}
					<button type="button" class="button-quiet" onclick={() => useBorder(current.border!)} title="Center {current.border.x}, {current.border.z}, radius {current.border.radius.toLocaleString()}">
						World border
					</button>
				{/if}
				<button type="button" class="button-quiet" onclick={() => moveTo({ x: 0, z: 0 })}>0, 0</button>
			</div>
		</div>
	</div>

	<div class="fields">
		<div class="field narrow">
			<label for="pregen-radius">{twoRadii(shape) ? 'Radius east-west' : 'Radius'}</label>
			<input id="pregen-radius" name="radius" type="number" min="16" step="1" bind:value={radius} required />
		</div>
		{#if twoRadii(shape)}
			<div class="field narrow">
				<label for="pregen-radius-z">Radius north-south</label>
				<input id="pregen-radius-z" name="radiusZ" type="number" min="16" step="1" bind:value={radiusZ} required />
			</div>
		{/if}
		<div class="field">
			<span class="label">Blocks</span>
			<div class="row">
				{#each PRESETS as r (r)}
					<button type="button" class="button-quiet" class:on={rx === r && rz === r} onclick={() => useRadius(r)}>{r.toLocaleString()}</button>
				{/each}
			</div>
		</div>
	</div>

	{#if !otherWorld}
		<ul class="legend small" aria-label="Map colours">
			<li><span class="swatch new"></span>Generated</li>
			<li><span class="swatch there"></span>Fully generated already</li>
			<li class="faint click-hint">Click the map to move the center there.</li>
			<li><button type="button" class="button-quiet small-button" onclick={fit}>Show all of it</button></li>
		</ul>
		<ChunkMap
			{overview}
			{regionUrl}
			selected={noSelection}
			center={start}
			{jump}
			{area}
			{layer}
			{describe}
			onpick={(px, pz) => ((x = px), (z = pz))}
			tapHint="Tap the map to move the center there."
		/>
	{/if}

	<div class="go">
		<p class="small summary">
			{#if otherWorld || overviewState === 'none'}
				About {total.toLocaleString()} chunks{overviewState === 'none' && !otherWorld ? ', none generated here yet' : ''}.
			{:else if overviewState === 'loading'}
				About {total.toLocaleString()} chunks in the area; reading which are there…
			{:else if there.unchecked}
				About {total.toLocaleString()} chunks in the area; checking which of the {(there.unchecked + there.existing).toLocaleString()}
				there are fully generated ({there.toCheck.length.toLocaleString()} region{there.toCheck.length === 1 ? '' : 's'} to go)…
			{:else if fresh === 0}
				Nothing to generate: all {total.toLocaleString()} chunks in the area are fully generated already.
			{:else}
				About <strong>{fresh.toLocaleString()} chunks to generate</strong> of {total.toLocaleString()} in the area{there.existing
					? `; ${there.existing.toLocaleString()} are fully generated already`
					: ''}.
				{#if estimate !== null}About {formatBytes(estimate)} more on disk.{/if}
			{/if}
			{running ? 'Generation is heavy work for the server; players notice it.' : 'Chunky runs in the server: start it to begin.'}
		</p>
		<button class="button-primary" type="submit" disabled={total === 0 || !running}>Start</button>
	</div>
</form>

<style>
	.planner {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.fields {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-3);
	}

	.fields .field {
		margin: 0;
	}

	.narrow {
		flex: 0 1 9rem;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1, 0.25rem);
	}

	.row .on {
		color: var(--accent);
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.9rem;
		margin: 0;
		padding: 0;
		list-style: none;
		color: var(--text-muted);
	}

	.legend li {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.swatch {
		width: 0.8rem;
		height: 0.8rem;
		border-radius: 2px;
	}

	.swatch.new {
		background: color-mix(in srgb, var(--accent) 35%, transparent);
		border: 1px solid var(--accent);
	}

	.swatch.there {
		background: var(--text-faint);
	}

	.small-button {
		font-size: 0.8rem;
		padding: 0.15rem 0.5rem;
	}

	.go {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.summary {
		margin: 0;
		flex: 1 1 20rem;
	}

	/* Without a mouse the map says it under itself ("Tap the map ...", ChunkMap's tapHint). */
	@media not ((hover: hover) and (pointer: fine)) {
		/* As specific as .legend li, which shows every item as flex. */
		.legend li.click-hint {
			display: none;
		}
	}
</style>
