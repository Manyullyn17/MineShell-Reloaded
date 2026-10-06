<script lang="ts">
	/**
	 * Deliberately not a charting library, but it does have real axes.
	 *
	 * The x-axis is a fixed window ending at the newest sample, capped at
	 * `windowMs`, so ten minutes of data and a full day do not look identical:
	 * a short run occupies a correspondingly short slice. Hovering reads out
	 * the sample under the pointer.
	 */
	let {
		points = [],
		max = null,
		label = '',
		unit = '',
		height = 150,
		windowMs = 24 * 60 * 60 * 1000,
		tone = 'accent',
		format = (v: number) => v.toFixed(0)
	}: {
		points?: { timestamp: number; value: number }[];
		max?: number | null;
		label?: string;
		unit?: string;
		height?: number;
		windowMs?: number;
		/** Which theme colour draws the line. */
		tone?: 'accent' | 'info';
		format?: (v: number) => string;
	} = $props();

	/** The SVG is stretched to its box; these are only its coordinate space. */
	const W = 540;
	const H = 100;
	/** Below this the axis labels would all read the same time. */
	const MIN_SPAN_MS = 60_000;

	const endsAt = $derived(points.length ? points[points.length - 1].timestamp : Date.now());
	const startsAt = $derived.by(() => {
		if (points.length < 2) return endsAt - MIN_SPAN_MS;
		const span = Math.min(windowMs, Math.max(MIN_SPAN_MS, endsAt - points[0].timestamp));
		return endsAt - span;
	});
	const span = $derived(Math.max(MIN_SPAN_MS, endsAt - startsAt));
	const visible = $derived(points.filter((p) => p.timestamp >= startsAt));

	const ceiling = $derived(max ?? Math.max(1, ...visible.map((p) => p.value)) * 1.15);

	const xFor = (timestamp: number) => ((timestamp - startsAt) / span) * W;
	const yFor = (value: number) => H - Math.min(1, value / ceiling) * H;

	const path = $derived(
		visible.length < 2
			? ''
			: visible.map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(p.timestamp).toFixed(1)},${yFor(p.value).toFixed(1)}`).join(' ')
	);
	const area = $derived(
		path
			? `${path} L${xFor(visible[visible.length - 1].timestamp).toFixed(1)},${H} L${xFor(visible[0].timestamp).toFixed(1)},${H} Z`
			: ''
	);
	const grid = $derived(
		[0.25, 0.5, 0.75].map((f) => `M0,${H - f * H} H${W}`).join(' ') +
			' ' +
			[0.25, 0.5, 0.75].map((f) => `M${f * W},0 V${H}`).join(' ')
	);

	const clock = (timestamp: number) =>
		new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

	const yTicks = $derived([1, 0.75, 0.5, 0.25, 0].map((f) => ({ f, label: `${format(ceiling * f)}${unit}` })));
	const xTicks = $derived(
		[0, 0.25, 0.5, 0.75, 1].map((f) => ({ f, label: f === 1 ? 'now' : clock(startsAt + span * f) }))
	);

	const latest = $derived(visible.length ? visible[visible.length - 1].value : 0);
	const average = $derived(visible.length ? visible.reduce((a, p) => a + p.value, 0) / visible.length : 0);
	const peak = $derived(Math.max(0, ...visible.map((p) => p.value)));

	let hover = $state<{ timestamp: number; value: number } | null>(null);

	function onMove(event: PointerEvent) {
		const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const at = startsAt + ((event.clientX - box.left) / box.width) * span;
		let best = visible[0];
		for (const p of visible) if (Math.abs(p.timestamp - at) < Math.abs(best.timestamp - at)) best = p;
		hover = best ?? null;
	}

	const hoverX = $derived(hover ? (xFor(hover.timestamp) / W) * 100 : 0);
	const hoverY = $derived(hover ? (yFor(hover.value) / H) * 100 : 0);
</script>

<figure class="chart" data-tone={tone} style="--height: {height}px">
	<figcaption>
		<span class="muted">{label}</span>
		<span class="numbers">
			{#if visible.length >= 2}
				<span class="faint">avg {format(average)}{unit} · peak {format(peak)}{unit}</span>
			{/if}
			<span class="mono value">{format(latest)}{unit}</span>
		</span>
	</figcaption>

	{#if path}
		<div class="frame">
			<div class="y-axis" aria-hidden="true">
				{#each yTicks as tick (tick.f)}
					<span style="top: {(1 - tick.f) * 100}%">{tick.label}</span>
				{/each}
			</div>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="plot" onpointermove={onMove} onpointerleave={() => (hover = null)}>
				<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label={label}>
					<path d={grid} class="grid" />
					<path d={area} class="fill" />
					<path d={path} class="line" />
				</svg>
				{#if hover}
					<div class="cursor" style="left: {hoverX}%"></div>
					<div class="marker" style="left: {hoverX}%; top: {hoverY}%"></div>
					<div class="tip" style="left: {hoverX}%; transform: translateX({hoverX > 70 ? '-105%' : '8px'})">
						<div class="faint">{clock(hover.timestamp)}</div>
						<div class="mono">{format(hover.value)}{unit}</div>
					</div>
				{/if}
			</div>
			<div></div>
			<div class="x-axis" aria-hidden="true">
				{#each xTicks as tick (tick.f)}
					<span
						style="left: {tick.f * 100}%; transform: translateX({tick.f === 0 ? '0' : tick.f === 1 ? '-100%' : '-50%'})"
						>{tick.label}</span
					>
				{/each}
			</div>
		</div>
	{:else}
		<p class="faint small no-data">Not enough samples yet.</p>
	{/if}
</figure>

<style>
	.chart {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		--line-colour: var(--accent);
	}

	.chart[data-tone='info'] {
		--line-colour: var(--info);
	}

	figcaption {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
		font-size: 0.87rem;
	}

	.numbers {
		display: flex;
		align-items: baseline;
		gap: 0.9rem;
	}

	.numbers .faint {
		font-size: 0.8rem;
	}

	.value {
		font-size: 1rem;
		font-weight: 500;
		color: var(--text);
	}

	.frame {
		display: grid;
		grid-template-columns: 2.75rem minmax(0, 1fr);
		grid-template-rows: var(--height) 1.1rem;
		margin-top: 0.6rem;
	}

	.y-axis,
	.x-axis {
		position: relative;
	}

	.y-axis span,
	.x-axis span {
		position: absolute;
		font-family: var(--font-mono);
		font-size: 0.7rem;
		color: var(--text-faint);
		white-space: nowrap;
	}

	.y-axis span {
		right: 0.5rem;
		transform: translateY(-50%);
	}

	.x-axis span {
		top: 0.25rem;
	}

	.plot {
		position: relative;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}

	svg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
	}

	.grid {
		fill: none;
		stroke: var(--line);
		stroke-width: 1;
		opacity: 0.6;
		vector-effect: non-scaling-stroke;
	}

	.line {
		fill: none;
		stroke: var(--line-colour);
		stroke-width: 1.6;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
	}

	.fill {
		fill: color-mix(in srgb, var(--line-colour) 14%, transparent);
		stroke: none;
	}

	.cursor {
		position: absolute;
		top: 0;
		bottom: 0;
		border-left: 1px dashed var(--text-muted);
		pointer-events: none;
	}

	.marker {
		position: absolute;
		width: 9px;
		height: 9px;
		margin: -4.5px 0 0 -4.5px;
		border-radius: 50%;
		background: var(--line-colour);
		border: 2px solid var(--bg-sunken);
		pointer-events: none;
	}

	.tip {
		position: absolute;
		top: 6px;
		z-index: 2;
		pointer-events: none;
		background: var(--panel-raised);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
		padding: 0.3rem 0.55rem;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
		white-space: nowrap;
		font-size: 0.75rem;
	}

	.tip .mono {
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text);
	}

	.no-data {
		border: 1px dashed var(--line);
		border-radius: var(--radius);
		font-size: 1rem;
		text-align: center;
		margin: 0;
		height: var(--height);
		max-width: none;
		display: grid;
		place-items: center;
	}
</style>
