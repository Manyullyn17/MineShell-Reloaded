<script lang="ts">
	import { untrack, type ComponentProps } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { enhance } from '#lib/shared/forms.js';
	import ChunkMap from '#lib/components/ChunkMap.svelte';
	import SegmentedChoice from '#lib/components/SegmentedChoice.svelte';
	import SnapshotChoice from '#lib/components/SnapshotChoice.svelte';
	import { chunkKey } from '#lib/shared/chunkmap.js';
	import {
		decodeAnalysis,
		formatTicks,
		heatStep,
		HEAT_STEPS,
		NO_CHUNK,
		PRUNE_TICKS,
		prunes,
		UNREADABLE,
		type AnalysedRegion,
		type PruneRule
	} from '#lib/shared/chunkprune.js';
	import { formatBytes, formatRelative } from '#lib/shared/format.js';

	type TaskState = { id: string; state: string; progress: number | null; step: string; error: string | null };

	/**
	 * World > Prune chunks: analyse a dimension, see the time players spent in
	 * each chunk as a heatmap, pick a threshold (the chunks that would go are
	 * marked as it changes), protect any of them on the map, then prune. The
	 * prune removes only chunks marked here (world.ts, pruneChunks).
	 */
	let {
		instanceId,
		dimensions,
		analysis,
		analysing,
		running,
		busy,
		snapshotPrompt
	}: {
		instanceId: string;
		dimensions: { key: string; label: string; overworld: boolean }[];
		/** The last analysis, without its chunks (those come from the endpoint). */
		analysis: { dimension: string; label: string; at: number; chunks: number; unreadable: number; spawn: { x: number; z: number } | null } | null;
		/** The analysis under way, from the server: shown by the button until the page reloads with its result. */
		analysing: { taskId: string; task: TaskState } | null;
		running: boolean;
		busy: boolean;
		snapshotPrompt: ComponentProps<typeof SnapshotChoice>['prompt'];
	} = $props();

	const id = $derived(encodeURIComponent(instanceId));

	let dimension = $state(untrack(() => analysis?.dimension ?? dimensions[0]?.key ?? ''));
	const isOverworld = $derived(dimensions.find((d) => d.key === dimension)?.overworld ?? false);
	let maxTicks = $state(1200);
	let keepAroundSpawn = $state(256);
	let showing = $state<'heat' | 'terrain'>('heat');
	let selecting = $state(false);
	const protect = new SvelteSet<string>();

	// Following the analysis under way, on the same stream as the notification center. Its id comes
	// from the action's answer (the page's data reloads later), or from the server's data when the
	// page is opened during one.
	let task = $state<TaskState | null>(untrack(() => analysing?.task ?? null));
	/** Clicked, the answer not back yet; then the task the action started, until the page has its result. */
	let submitting = $state(false);
	let startedTask = $state<string | null>(null);
	let analysedBefore: number | null = null;
	const followed = $derived(startedTask ?? analysing?.taskId ?? null);
	$effect(() => {
		// The new analysis is in the page's data: the map takes over.
		if (startedTask && (analysis?.at ?? null) !== analysedBefore) startedTask = null;
	});
	$effect(() => {
		const taskId = followed;
		task = untrack(() => analysing?.task ?? null);
		if (!taskId) return;
		const source = new EventSource('/api/tasks?stream=1&brief=1');
		source.addEventListener('tasks', (event) => {
			const found = (JSON.parse((event as MessageEvent).data) as TaskState[]).find((t) => t.id === taskId);
			if (found) task = found;
			if (found && found.state !== 'running') source.close();
		});
		return () => source.close();
	});
	// The page reloads when the task finishes; until its data has the result, the button stays off.
	const inProgress = $derived(submitting || (!!followed && task?.state !== 'failed' && task?.state !== 'cancelled'));

	// The analysis's chunks, fetched when there is one of this dimension.
	const current = $derived(analysis && analysis.dimension === dimension ? analysis : null);
	let regions = $state.raw<AnalysedRegion[] | null>(null);
	let loadError = $state<string | null>(null);
	$effect(() => {
		const wanted = current;
		regions = null;
		loadError = null;
		if (!wanted) return;
		let stale = false;
		fetch(`/api/instances/${id}/prune-analysis?dimension=${encodeURIComponent(wanted.dimension)}&at=${wanted.at}`)
			.then(async (res) => {
				if (stale) return;
				if (res.status === 204) loadError = 'The analysis is gone (MineShell restarted, or the world was pruned): analyse again.';
				else if (!res.ok) loadError = 'The analysis could not be read.';
				else regions = decodeAnalysis(await res.arrayBuffer()).regions;
			})
			.catch(() => {
				if (!stale) loadError = 'The analysis could not be read.';
			});
		return () => (stale = true);
	});

	// Protected chunks belong to one dimension: picking another starts over.
	let protectFor = untrack(() => dimension);
	$effect(() => {
		if (dimension !== protectFor) {
			protect.clear();
			protectFor = dimension;
		}
	});

	const rule = $derived<PruneRule>({
		maxTicks,
		keep: isOverworld && current?.spawn && keepAroundSpawn > 0 ? { ...current.spawn, radius: keepAroundSpawn } : null
	});

	// Codes per chunk for the map's layer: 1-7 the heat steps, 8 would go, 9 unreadable.
	const PRUNED = 8;
	const UNREAD = 9;
	const HEAT_COLOURS = ['', ...HEAT_STEPS.map((_, i) => `--heat-${i + 1}`), '--error', '--text-faint'];
	const TERRAIN_COLOURS = ['', ...HEAT_STEPS.map(() => ''), '--error', ''];

	const byRegion = $derived(new Map((regions ?? []).map((r) => [`${r.x},${r.z}`, r])));
	const overview = $derived(
		(regions ?? []).map((r) => {
			const bits = new Uint8Array(128);
			for (let i = 0; i < 1024; i++) if (r.ticks[i] !== NO_CHUNK) bits[i >> 3] |= 1 << (i & 7);
			return { x: r.x, z: r.z, chunks: btoa(String.fromCharCode(...bits)) };
		})
	);

	/** Last codes per region: an unchanged region keeps its array, so the map does not draw it again. */
	let previous = new Map<string, Uint8Array>();
	const preview = $derived.by(() => {
		const codes = new Map<string, Uint8Array>();
		let remove = 0;
		let bytes = 0;
		let saved = 0;
		for (const r of regions ?? []) {
			const key = `${r.x},${r.z}`;
			const next = new Uint8Array(1024);
			for (let i = 0; i < 1024; i++) {
				const t = r.ticks[i];
				if (t === NO_CHUNK) continue;
				if (t === UNREADABLE) {
					next[i] = UNREAD;
					continue;
				}
				const cx = r.x * 32 + (i % 32);
				const cz = r.z * 32 + Math.floor(i / 32);
				if (prunes(t, cx, cz, rule)) {
					if (protect.has(chunkKey(cx, cz))) {
						saved++;
						next[i] = heatStep(t);
					} else {
						remove++;
						bytes += r.sectors[i] * 4096;
						next[i] = PRUNED;
					}
				} else next[i] = heatStep(t);
			}
			const old = previous.get(key);
			codes.set(key, old && old.every((v, i) => v === next[i]) ? old : next);
		}
		return { codes, remove, bytes, saved };
	});
	$effect(() => {
		previous = preview.codes;
	});

	// In terrain view only the chunks that would go are marked, see-through.
	const layer = $derived(
		showing === 'heat'
			? { regions: preview.codes, colours: HEAT_COLOURS, alpha: 1 }
			: { regions: preview.codes, colours: TERRAIN_COLOURS, alpha: 0.55 }
	);
	const regionUrl = $derived(
		showing === 'terrain'
			? (x: number, z: number) => `/api/instances/${id}/chunkmap/region?dimension=${encodeURIComponent(dimension)}&source=live&x=${x}&z=${z}`
			: null
	);
	const circle = $derived(rule.keep);
	const center = $derived(current?.spawn ?? { x: 0, z: 0 });

	function describe(cx: number, cz: number): string | null {
		const r = byRegion.get(`${Math.floor(cx / 32)},${Math.floor(cz / 32)}`);
		const t = r?.ticks[(((cx % 32) + 32) % 32) + 32 * (((cz % 32) + 32) % 32)];
		if (t === undefined || t === NO_CHUNK) return null;
		if (t === UNREADABLE) return 'Could not be read: stays';
		const going = prunes(t, cx, cz, rule);
		const fate = !going ? 'stays' : protect.has(chunkKey(cx, cz)) ? 'protected' : 'would go';
		return `Visited ${formatTicks(t)} · ${fate}`;
	}
</script>

<div class="controls">
	<div class="field">
		<label for="prune-dimension">Dimension</label>
		<select id="prune-dimension" bind:value={dimension}>
			{#each dimensions as d (d.key)}
				<option value={d.key}>{d.label}</option>
			{/each}
		</select>
	</div>
	<form
		method="POST"
		action="?/pruneAnalyse"
		use:enhance={() => {
			submitting = true;
			analysedBefore = analysis?.at ?? null;
			return async ({ result, update }) => {
				if (result.type === 'success' && typeof result.data?.taskId === 'string') {
					task = null;
					startedTask = result.data.taskId;
				}
				submitting = false;
				await update({ reset: false });
			};
		}}
	>
		<input type="hidden" name="dimension" value={dimension} />
		<button type="submit" class={current ? '' : 'button-primary'} disabled={busy || inProgress}>
			{inProgress ? 'Analysing…' : current ? 'Analyse again' : 'Analyse'}
		</button>
	</form>
	{#if inProgress}
		<div class="analysing" aria-live="polite">
			<div class="small muted">
				{task?.step ?? 'Starting'}{#if task?.progress != null}<span class="faint"> · {task.progress}%</span>{/if}
			</div>
			<div class="progress" role="progressbar" aria-label="Analysing" aria-valuenow={task?.progress ?? undefined}>
				<span class:indeterminate={task?.progress == null} style="width: {task?.progress ?? 100}%"></span>
			</div>
		</div>
	{:else if followed && task?.state === 'failed'}
		<p class="error-text small analysed">The analysis failed{task.error ? `: ${task.error}` : '.'}</p>
	{:else if current}
		<p class="hint small analysed">
			{current.chunks.toLocaleString()} chunks, analysed {formatRelative(current.at)}{current.unreadable
				? `; ${current.unreadable.toLocaleString()} could not be read and stay`
				: ''}.
		</p>
	{/if}
</div>

{#if !current}
	<p class="muted small">
		Analysing reads every region file of {dimensions.find((d) => d.key === dimension)?.label ?? 'the dimension'} and changes
		nothing, so it also works while the server runs. The map then shows how long players spent in each chunk.
	</p>
{:else if loadError}
	<p class="error-text">{loadError}</p>
{:else if !regions}
	<p class="muted small">Loading the analysis…</p>
{:else if !regions.length}
	<p class="empty small">{current.label} has no chunks yet.</p>
{:else}
	<div class="controls">
		<div class="field">
			<label for="prune-ticks">Delete chunks visited less than</label>
			<select id="prune-ticks" bind:value={maxTicks}>
				{#each PRUNE_TICKS as option (option.ticks)}
					<option value={option.ticks}>{option.label}</option>
				{/each}
			</select>
		</div>
		{#if isOverworld && current.spawn}
			<div class="field">
				<label for="prune-keep">Always keep within (blocks of spawn)</label>
				<input id="prune-keep" type="number" min="0" step="16" bind:value={keepAroundSpawn} />
			</div>
		{/if}
		<div class="field">
			<span class="label" id="prune-showing">Map shows</span>
			<SegmentedChoice
				labelledby="prune-showing"
				options={[
					{ value: 'heat', label: 'Time spent' },
					{ value: 'terrain', label: 'Terrain' }
				]}
				bind:value={showing}
			/>
		</div>
	</div>

	<div class="map-bar">
		<p class="hint small controls-mouse">
			Red chunks would go. Click one to protect it; Shift-drag protects an area, Ctrl-drag clears one.
		</p>
		<p class="hint small controls-touch">
			Red chunks would go. Tap one to protect it; turn on Select to drag over an area (starting on a protected chunk clears).
		</p>
		<div class="map-tools">
			<button type="button" class="button-quiet controls-touch" aria-pressed={selecting} class:on={selecting} onclick={() => (selecting = !selecting)}>Select</button>
		</div>
	</div>

	<ul class="legend small" aria-label="Map colours">
		{#if showing === 'heat'}
			{#each HEAT_STEPS as step, i (step.label)}
				<li><span class="swatch" style:background="var(--heat-{i + 1})"></span>{step.label}</li>
			{/each}
		{/if}
		<li><span class="swatch" style:background="var(--error)"></span>Would go</li>
		<li><span class="swatch protected"></span>Protected</li>
		{#if showing === 'heat' && current.unreadable}
			<li><span class="swatch" style:background="var(--text-faint)"></span>Could not be read</li>
		{/if}
		{#if circle}<li><span class="swatch circle"></span>Kept around spawn</li>{/if}
	</ul>

	<ChunkMap {overview} {regionUrl} selected={protect} {center} {selecting} {layer} {circle} {describe} tapHint="Tap a chunk to protect it and see how long players spent there." />

	<form
		class="prune"
		method="POST"
		action="?/prune"
		use:enhance={({ cancel, formData }) => {
			if (!confirm(`Delete ${preview.remove.toLocaleString()} chunks from ${current.label}?`)) return cancel();
			formData.set('protect', [...protect].join(';'));
			return async ({ result, update }) => {
				if (result.type === 'success') protect.clear();
				await update({ reset: false });
			};
		}}
	>
		<input type="hidden" name="dimension" value={dimension} />
		<input type="hidden" name="maxTicks" value={maxTicks} />
		<input type="hidden" name="keepAroundSpawn" value={rule.keep ? keepAroundSpawn : 0} />
		<input type="hidden" name="analysedAt" value={current.at} />
		<p class="result">
			<strong class="mono">{preview.remove.toLocaleString()}</strong> of {current.chunks.toLocaleString()} chunks would go,
			freeing about <strong class="mono">{formatBytes(preview.bytes)}</strong> of terrain (entities and points of interest free a
			little more).
			{#if preview.saved}{preview.saved.toLocaleString()} protected.{/if}
			{#if protect.size}<button type="button" class="button-quiet small" onclick={() => protect.clear()}>Clear protection</button>{/if}
		</p>
		<p class="hint small">
			Only chunks marked here go: one generated or visited since the analysis stays.
		</p>
		<SnapshotChoice moves prompt={snapshotPrompt} idPrefix="prune" />
		{#if running}<p class="warn-text small">Stop the server to prune. Analysing and protecting work while it runs.</p>{/if}
		<button class="button-danger" type="submit" disabled={running || busy || preview.remove === 0}>
			Prune {preview.remove.toLocaleString()} chunks
		</button>
	</form>
{/if}

<style>
	p {
		max-width: none;
	}

	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem 1rem;
		align-items: flex-end;
		margin-bottom: 0.75rem;
	}

	.controls .field,
	.controls form {
		margin: 0;
	}

	.analysed {
		margin: 0;
		align-self: center;
	}

	.analysing {
		flex: 0 1 18rem;
		min-width: 10rem;
		align-self: center;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.label {
		display: block;
		margin-bottom: 0.3rem;
		font-size: 0.85rem;
		color: var(--text-muted);
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

	.map-tools .on {
		color: var(--accent-contrast);
		background: var(--accent);
		border-color: var(--accent);
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.9rem;
		margin: 0 0 0.5rem;
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

	.swatch.protected {
		background: color-mix(in srgb, var(--accent) 30%, transparent);
		border: 2px solid var(--accent);
	}

	.swatch.circle {
		border: 1.5px dashed var(--text);
		border-radius: 50%;
	}

	.prune {
		margin-top: 1rem;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.6rem;
	}

	.prune p {
		margin: 0;
	}
</style>
