<script lang="ts">
	/**
	 * An amount as a slider notched at every whole unit (GB of memory, CPU cores,
	 * chunks), with a box beside it for an exact number, which takes any amount
	 * from `boxMin`. Posts `value` in its own unit (MB, percent, chunks) as
	 * `name`, `scale` of those per shown unit, so actions read what the number
	 * field it replaced posted. The slider runs from `low` to `high` shown units
	 * in steps of `step`, and further when the value already is beyond `high`.
	 */
	let {
		id,
		name,
		value = $bindable(),
		label,
		unit,
		scale = 1,
		low,
		high,
		step = 1,
		boxMin = low,
		boxMax,
		form,
		oninput
	}: {
		/** The box's id, for the field's <label for>. */
		id: string;
		name: string;
		/** In posted units. Null: nothing set; posted empty, so the action keeps its fallback. */
		value: number | null;
		/** What the slider is, for screen readers ("Maximum memory"). */
		label: string;
		/** The shown unit: "GB", "cores", "chunks". */
		unit: string;
		scale?: number;
		low: number;
		high: number;
		step?: number;
		boxMin?: number;
		boxMax?: number;
		/** A form elsewhere on the page that posts it (the form attribute). */
		form?: string;
		oninput?: () => void;
	} = $props();

	const shown = $derived(value === null ? null : Math.round((value / scale) * 100) / 100);
	const top = $derived(Math.max(high, Math.ceil(shown ?? 0), low + step));
	const span = $derived(top - low);
	const at = (n: number) => (n - low) / span;
	// Whole units inside the range get notches and, as many as fit the slider's width
	// (about 2rem each, at most eight), numbers: round ones (4, 8, 12 ...) and the first,
	// so it shows where the slider begins. Notches only while they stay a few pixels apart.
	let width = $state(240);
	const fit = $derived(Math.min(8, Math.max(1, Math.floor(width / 32))));
	const every = $derived([1, 2, 4, 8, 16, 32, 64].find((n) => span / n <= fit) ?? 128);
	const wholes = $derived(Array.from({ length: Math.floor(top) - Math.ceil(low) + 1 }, (_, i) => Math.ceil(low) + i));
	const notches = $derived(width / span >= 4 ? wholes : []);
	const numbered = $derived([...new Set([low, ...wholes.filter((n) => n % every === 0)])].filter((n) => n === low || at(n) - at(low) >= 0.08));

	function set(amount: number) {
		value = amount;
		oninput?.();
	}
</script>

<div class="notched-input" class:unset={value === null}>
	<div class="slider">
		<input
			type="range"
			min={low}
			max={top}
			{step}
			value={Math.min(top, Math.max(low, Math.round((shown ?? low) / step) * step))}
			aria-label="{label} ({unit})"
			aria-valuetext={shown === null ? 'not set' : `${shown} ${unit}`}
			oninput={(e) => set(Math.round(e.currentTarget.valueAsNumber * scale))}
		/>
		<div class="notches" aria-hidden="true" bind:clientWidth={width}>
			{#each notches as n (n)}
				<span class="notch" style:--at={at(n)}></span>
			{/each}
			{#each numbered as n (n)}
				<span class="number" style:--at={at(n)}>{n}</span>
			{/each}
		</div>
	</div>
	<span class="amount">
		<input
			{id}
			type="number"
			min={boxMin}
			max={boxMax}
			step="any"
			value={shown}
			oninput={(e) => {
				const n = e.currentTarget.valueAsNumber;
				if (Number.isFinite(n) && n > 0) set(Math.round(n * scale));
			}}
		/>
		{unit}
	</span>
	<input type="hidden" {name} {form} value={value === null ? '' : Math.round(value)} />
</div>

<style>
	.notched-input {
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
	/* Nothing set: the thumb only marks where the slider starts. */
	.unset input[type='range']::-webkit-slider-thumb {
		background: var(--line-strong);
	}
	.unset input[type='range']::-moz-range-thumb {
		background: var(--line-strong);
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
