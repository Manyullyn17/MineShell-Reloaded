<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { can, type InstancePermission } from '#lib/shared/access.js';
	import { enhance } from '#lib/shared/forms.js';
	import Flash from '#lib/components/Flash.svelte';
	import ChunkMap from '#lib/components/ChunkMap.svelte';
	import SegmentedChoice from '#lib/components/SegmentedChoice.svelte';
	import { formatDateTime } from '#lib/shared/format.js';

	let { data, form } = $props();
	const may = (permission: InstancePermission) => can(data.access, data.instance.id, permission);
	const id = $derived(encodeURIComponent(data.instance.id));
	const busy = $derived(data.instance.status === 'provisioning');

	const TABS = [
		['snapshots', 'Snapshots'],
		['worlds', 'Worlds'],
		['pregen', 'Pre-generate'],
		['prune', 'Prune chunks'],
		['reset', 'Replace or reset']
	] as const;

	// The dimension to work on, and the snapshot to take chunks from (only ones that hold it).
	let dimension = $state(untrack(() => data.dimensions[0]?.key ?? data.snapshots[0]?.dimensions[0]?.key ?? ''));
	const dimensionLabel = $derived(
		data.dimensions.find((d) => d.key === dimension)?.label ?? data.snapshots.flatMap((s) => s.dimensions).find((d) => d.key === dimension)?.label ?? dimension
	);
	const allDimensions = $derived([
		...data.dimensions,
		...data.snapshots.flatMap((s) => s.dimensions).filter((d, i, all) => !data.dimensions.some((l) => l.key === d.key) && all.findIndex((o) => o.key === d.key) === i)
	]);
	const usable = $derived(data.snapshots.filter((s) => s.dimensions.some((d) => d.key === dimension)));
	// The newest snapshot first, passing over the ones a chunk restore left behind.
	const preferred = (list: typeof data.snapshots) => (list.find((s) => !s.beforeChunkRestore) ?? list[0])?.id ?? '';
	let snapshotId = $state(untrack(() => preferred(data.snapshots)));
	$effect(() => {
		if (!usable.some((s) => s.id === snapshotId)) snapshotId = preferred(usable);
	});

	/** Which picture the map shows: the world as it is now, or the snapshot's. */
	let showing = $state<'live' | 'snapshot'>('live');
	const source = $derived(showing === 'snapshot' && snapshotId ? snapshotId : 'live');

	let overview = $state<{ x: number; z: number; chunks: string }[]>([]);
	let overviewError = $state<string | null>(null);
	let reloads = $state(0);
	$effect(() => {
		const url = `/api/instances/${id}/chunkmap?dimension=${encodeURIComponent(dimension)}&source=${encodeURIComponent(source)}`;
		void reloads;
		let stale = false;
		overviewError = null;
		fetch(url)
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
			.then((body: { regions: typeof overview }) => {
				if (!stale) overview = body.regions;
			})
			.catch(() => {
				if (!stale) overviewError = 'The map could not be read.';
			});
		return () => (stale = true);
	});
	const regionUrl = (x: number, z: number) =>
		`/api/instances/${id}/chunkmap/region?dimension=${encodeURIComponent(dimension)}&source=${encodeURIComponent(source)}&x=${x}&z=${z}&r=${reloads}`;

	const selected = new SvelteSet<string>();
	// Chunks belong to one dimension: picking another starts over.
	let selectedFor = untrack(() => dimension);
	$effect(() => {
		if (dimension !== selectedFor) {
			selected.clear();
			selectedFor = dimension;
		}
	});
	const regionCount = $derived(new Set([...selected].map((k) => k.split(',').map((n) => Math.floor(Number(n) / 32)).join(','))).size);
	const chunkList = $derived([...selected].join(';'));
	let selecting = $state(false);

	// Jumping to a block position.
	let jumpX = $state('');
	let jumpZ = $state('');
	let jump = $state<{ x: number; z: number } | null>(null);
	// Where the map opens: the world spawn. Later data does not move it.
	const center = untrack(() => data.spawn ?? { x: 0, z: 0 });
	function go(e: SubmitEvent) {
		e.preventDefault();
		const x = Number(jumpX);
		const z = Number(jumpZ);
		if (jumpX.trim() !== '' && jumpZ.trim() !== '' && Number.isFinite(x) && Number.isFinite(z)) jump = { x, z };
	}

	const snapshotLabel = (s: (typeof data.snapshots)[number]) => `${formatDateTime(s.createdAt)} · ${s.note ?? s.label}${s.partial ? ' (part of the world)' : ''}`;
</script>

<div class="subhead">
	<nav class="subtabs" aria-label="World sections">
		{#each TABS.filter(([tab]) => tab === 'snapshots' || tab === 'worlds' || may('world')) as [tab, label] (tab)}
			<a href="/instances/{id}/world?view={tab}">{label}</a>
		{/each}
		<a href="/instances/{id}/world/chunks" aria-current="page">Restore chunks</a>
	</nav>
</div>

<Flash {form} />

<p class="hint intro">
	Put chosen chunks back as a snapshot has them - a griefed build, a broken area - and leave the rest of the world as it is.
	Terrain, mobs and points of interest come back together; a chosen chunk the snapshot does not have goes, and generates
	again.
</p>

{#if !data.snapshots.length}
	<p class="empty">No snapshot of {data.levelName} holds a dimension yet. Take one under <a href="/instances/{id}/world?view=snapshots">Snapshots</a> first.</p>
{:else}
	<div class="controls">
		<div class="field">
			<label for="chunks-dimension">Dimension</label>
			<select id="chunks-dimension" bind:value={dimension}>
				{#each allDimensions as d (d.key)}
					<option value={d.key}>{d.label}</option>
				{/each}
			</select>
		</div>
		<div class="field grow">
			<label for="chunks-snapshot">Restore from</label>
			<select id="chunks-snapshot" bind:value={snapshotId} disabled={!usable.length}>
				{#each usable as s (s.id)}
					<option value={s.id}>{snapshotLabel(s)}</option>
				{:else}
					<option value="">No snapshot has {dimensionLabel}</option>
				{/each}
			</select>
		</div>
		<div class="field">
			<span class="label" id="chunks-showing">Map shows</span>
			<SegmentedChoice
				labelledby="chunks-showing"
				options={[
					{ value: 'live', label: 'Now' },
					{ value: 'snapshot', label: 'Snapshot' }
				]}
				bind:value={showing}
				disabled={!snapshotId}
			/>
		</div>
		<form class="field jump" onsubmit={go}>
			<span class="label">Go to</span>
			<div class="jump-row">
				<input type="text" inputmode="numeric" aria-label="Block x" placeholder="x" bind:value={jumpX} />
				<input type="text" inputmode="numeric" aria-label="Block z" placeholder="z" bind:value={jumpZ} />
				<button type="submit" class="button-quiet">Go</button>
			</div>
		</form>
	</div>

	<div class="map-bar">
		<!-- One of the two shows, by the pointer the device has (CSS, so the right one is there from the first paint). -->
		<p class="hint small controls-mouse">
			Drag to move, scroll to zoom, click a chunk to select it. Shift-drag selects an area, Ctrl-drag clears one.
		</p>
		<p class="hint small controls-touch">
			Drag to move, pinch to zoom, tap a chunk to select it. Turn on Select to drag over an area; starting on a selected
			chunk clears instead.
		</p>
		<div class="map-tools">
			<button type="button" class="button-quiet controls-touch" aria-pressed={selecting} class:on={selecting} onclick={() => (selecting = !selecting)}>Select</button>
			<button type="button" class="button-quiet" title="Read the region files again" onclick={() => reloads++}>Reload map</button>
		</div>
	</div>

	{#if overviewError}
		<p class="error-text">{overviewError}</p>
	{:else if !overview.length}
		<p class="empty small">{showing === 'snapshot' ? 'The snapshot' : 'The world'} has no chunks in {dimensionLabel}{showing === 'live' ? ' yet' : ''}.</p>
	{/if}
	<ChunkMap {overview} {regionUrl} {selected} {center} {selecting} {jump} />

	<form
		class="restore"
		method="POST"
		action="?/restore"
		use:enhance={() => async ({ result, update }) => {
			if (result.type === 'success') selected.clear();
			await update({ reset: false });
		}}
	>
		<input type="hidden" name="id" value={snapshotId} />
		<input type="hidden" name="dimension" value={dimension} />
		<input type="hidden" name="chunks" value={chunkList} />
		<div class="selection">
			<strong>{selected.size} chunk{selected.size === 1 ? '' : 's'}</strong>
			{#if selected.size}
				<span class="hint">in {regionCount} region file{regionCount === 1 ? '' : 's'}</span>
				<button type="button" class="button-quiet" onclick={() => selected.clear()}>Clear</button>
			{:else}
				<span class="hint">selected</span>
			{/if}
		</div>
		{#if selected.size > data.maxChunks}
			<p class="warn-text small">At most {data.maxChunks} chunks at once; restore the whole dimension from the Snapshots tab instead.</p>
		{/if}
		{#if selected.size}
			<p class="hint small">
				The region files this changes are kept as a snapshot first (moved, not copied), so restoring that one undoes it.
			</p>
		{/if}
		{#if data.running}
			<p class="warn-text small">Stop the server to restore chunks: it would write over them. Picking works while it runs.</p>
		{/if}
		<button class="button-primary" type="submit" disabled={!selected.size || !snapshotId || data.running || busy || selected.size > data.maxChunks}>
			{selected.size ? `Restore ${selected.size} chunk${selected.size === 1 ? '' : 's'}` : 'Restore chunks'} from the snapshot
		</button>
	</form>
{/if}

<style>
	.intro {
		margin: 0 0 1rem;
		max-width: 60rem;
	}

	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem 1rem;
		align-items: flex-end;
		margin-bottom: 0.75rem;
	}

	.controls .field {
		margin: 0;
	}

	.controls .grow {
		flex: 1 1 18rem;
		min-width: 0;
	}

	.controls select {
		max-width: 100%;
	}

	.label {
		display: block;
		margin-bottom: 0.3rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.jump-row {
		display: flex;
		gap: 0.35rem;
	}

	.jump-row input {
		width: 6.5rem;
		min-width: 0;
	}

	.map-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1rem;
		margin-bottom: 0.5rem;
	}

	.map-bar p {
		margin: 0;
	}

	.controls-mouse {
		display: none;
	}

	@media (hover: hover) and (pointer: fine) {
		.controls-mouse {
			display: block;
		}

		.controls-touch {
			display: none;
		}
	}

	.map-tools {
		display: flex;
		gap: 0.35rem;
	}

	.map-tools .on {
		color: var(--accent-contrast);
		background: var(--accent);
		border-color: var(--accent);
	}

	.restore {
		margin-top: 1rem;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.6rem;
	}

	.selection {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
</style>
