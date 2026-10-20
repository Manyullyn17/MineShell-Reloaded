<script lang="ts">
	/**
	 * A memory amount: a slider that snaps to whole GB (1024 MB, as Java's -Xmx
	 * counts), notched at each one, and a box beside it for the exact number,
	 * which takes any amount. Posts whole MB as `name`, like the number field it
	 * replaced, so the actions read it as before. The slider runs from 1 GB to
	 * 16 GB (less on a machine with less RAM), so each GB gets room; further
	 * only when the value already is. The box takes more.
	 */
	let {
		id,
		name,
		value = $bindable(),
		label,
		minMb = 512,
		machineMb,
		form,
		oninput
	}: {
		/** The box's id, for the field's <label for>. */
		id: string;
		name: string;
		/** Null: nothing set; posted empty, so the action keeps its fallback. */
		value: number | null;
		/** What the slider is, for screen readers ("Maximum memory"). */
		label: string;
		minMb?: number;
		machineMb: number;
		/** A form elsewhere on the page that posts it (the form attribute). */
		form?: string;
		oninput?: () => void;
	} = $props();

	const GB = 1024;
	const lowGb = 1;
	const capGb = 16;
	const highGb = $derived(Math.max(Math.min(capGb, Math.ceil(machineMb / GB)), Math.ceil((value ?? 0) / GB), lowGb + 1));
	const gb = $derived(value === null ? null : Math.round((value / GB) * 100) / 100);
	const span = $derived(highGb - lowGb);
	// As many numbers as fit the slider's width (about 2rem each, at most eight); every
	// notch drawn while they stay a few pixels apart.
	let width = $state(240);
	const fit = $derived(Math.min(8, Math.max(1, Math.floor(width / 32))));
	const every = $derived([1, 2, 4, 8, 16, 32, 64].find((n) => span / n <= fit) ?? 128);
	const notches = $derived(width / span >= 4 ? Array.from({ length: span + 1 }, (_, i) => lowGb + i) : []);
	// Round numbers (4, 8, 12 ...), with 1 GB at the start only when it is not crowded.
	const numbered = $derived(
		Array.from({ length: span + 1 }, (_, i) => lowGb + i).filter((n) => n % every === 0 || (n === lowGb && every <= 2))
	);

	function set(mb: number) {
		value = mb;
		oninput?.();
	}
</script>

<div class="memory-input">
	<div class="slider">
		<input
			type="range"
			min={lowGb}
			max={highGb}
			step="1"
			value={Math.min(highGb, Math.max(lowGb, Math.round(gb ?? lowGb)))}
			aria-label="{label} (GB)"
			aria-valuetext={gb === null ? 'not set' : `${gb} GB`}
			oninput={(e) => set(e.currentTarget.valueAsNumber * GB)}
		/>
		<div class="notches" aria-hidden="true" bind:clientWidth={width}>
			{#each notches as n (n)}
				<span class="notch" style:--at={(n - lowGb) / span}></span>
			{/each}
			{#each numbered as n (n)}
				<span class="number" style:--at={(n - lowGb) / span}>{n}</span>
			{/each}
		</div>
	</div>
	<span class="amount">
		<input
			{id}
			type="number"
			min={minMb / GB}
			step="any"
			value={gb}
			oninput={(e) => {
				const n = e.currentTarget.valueAsNumber;
				if (Number.isFinite(n) && n > 0) set(Math.round(n * GB));
			}}
		/>
		GB
	</span>
	<input type="hidden" {name} {form} value={value === null ? '' : Math.round(value)} />
</div>

<style>
	.memory-input {
		--thumb: 1rem;
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
	}
	.slider {
		flex: 1;
		min-width: 8rem;
		padding-top: 0.35rem;
	}
	input[type='range'] {
		appearance: none;
		-webkit-appearance: none;
		display: block;
		width: 100%;
		height: var(--thumb);
		margin: 0;
		background: transparent;
		cursor: pointer;
	}
	input[type='range']::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 2px;
		background: var(--line-strong);
	}
	input[type='range']::-moz-range-track {
		height: 4px;
		border-radius: 2px;
		background: var(--line-strong);
	}
	input[type='range']::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: var(--thumb);
		height: var(--thumb);
		margin-top: calc(2px - var(--thumb) / 2);
		border: none;
		border-radius: 50%;
		background: var(--accent);
	}
	input[type='range']::-moz-range-thumb {
		width: var(--thumb);
		height: var(--thumb);
		border: none;
		border-radius: 50%;
		background: var(--accent);
	}
	input[type='range']:focus-visible::-webkit-slider-thumb {
		outline: 2px solid var(--accent-hover);
		outline-offset: 2px;
	}
	input[type='range']:focus-visible::-moz-range-thumb {
		outline: 2px solid var(--accent-hover);
		outline-offset: 2px;
	}
	/* Notches sit under the thumb's centre at each value: the track's ends are half a thumb in. */
	.notches {
		position: relative;
		height: 1.3rem;
		margin-top: 0.15rem;
	}
	.notch,
	.number {
		position: absolute;
		left: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--at));
		transform: translateX(-50%);
	}
	.notch {
		top: 0;
		width: 1px;
		height: 0.35rem;
		background: var(--line-strong);
	}
	.number {
		top: 0.4rem;
		font-size: 0.72rem;
		line-height: 1;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.amount {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		white-space: nowrap;
		color: var(--text-muted);
	}
	.amount input {
		width: 5rem;
	}
</style>
