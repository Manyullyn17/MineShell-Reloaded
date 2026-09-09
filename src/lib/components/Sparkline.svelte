<script lang="ts">
	/**
	 * Deliberately not a charting library, but it does have real axes now.
	 *
	 * The earlier version stretched whatever samples existed across the full
	 * width, so ten minutes of data and a full day looked identical and the
	 * shape implied a time span it did not have. Here the x-axis is a fixed
	 * window ending at the newest sample, so a short run occupies a
	 * correspondingly short slice and the empty part is visibly empty.
	 */
	let {
		points = [],
		max = null,
		label = '',
		unit = '',
		height = 110,
		windowMs = 24 * 60 * 60 * 1000,
		format = (v: number) => v.toFixed(0)
	}: {
		points?: { timestamp: number; value: number }[];
		max?: number | null;
		label?: string;
		unit?: string;
		height?: number;
		windowMs?: number;
		format?: (v: number) => string;
	} = $props();

	const WIDTH = 600;
	const PAD_LEFT = 46;
	const PAD_BOTTOM = 18;
	const PAD_TOP = 6;
	/** Below this the axis labels would all read the same time. */
	const MIN_SPAN_MS = 60_000;

	const plotWidth = WIDTH - PAD_LEFT;
	const plotHeight = $derived(height - PAD_BOTTOM - PAD_TOP);

	// The axis spans the data that actually exists, capped at the requested
	// window. A server up for ten minutes gets a ten-minute axis rather than a
	// short stub against 23 hours of empty chart.
	const endsAt = $derived(points.length ? points[points.length - 1].timestamp : Date.now());
	const startsAt = $derived.by(() => {
		if (points.length < 2) return endsAt - MIN_SPAN_MS;
		const earliest = points[0].timestamp;
		const span = Math.min(windowMs, Math.max(MIN_SPAN_MS, endsAt - earliest));
		return endsAt - span;
	});
	const span = $derived(Math.max(MIN_SPAN_MS, endsAt - startsAt));

	const ceiling = $derived(max ?? Math.max(1, ...points.map((p) => p.value)) * 1.15);

	function xFor(timestamp: number, from: number, width: number): number {
		return PAD_LEFT + ((timestamp - from) / width) * plotWidth;
	}

	function yFor(value: number, top: number): number {
		return PAD_TOP + top - Math.min(1, value / ceiling) * top;
	}

	const visible = $derived(points.filter((p) => p.timestamp >= startsAt));

	const path = $derived.by(() => {
		if (visible.length < 2) return '';
		return visible
			.map(
				(p, i) =>
					`${i === 0 ? 'M' : 'L'}${xFor(p.timestamp, startsAt, span).toFixed(1)},${yFor(p.value, plotHeight).toFixed(1)}`
			)
			.join(' ');
	});

	const area = $derived.by(() => {
		if (!path || visible.length < 2) return '';
		const firstX = xFor(visible[0].timestamp, startsAt, span).toFixed(1);
		const lastX = xFor(visible[visible.length - 1].timestamp, startsAt, span).toFixed(1);
		const base = (PAD_TOP + plotHeight).toFixed(1);
		return `${path} L${lastX},${base} L${firstX},${base} Z`;
	});

	/** Gridlines labelled with the value they represent. */
	const yTicks = $derived(
		[0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
			fraction,
			value: ceiling * fraction,
			y: PAD_TOP + plotHeight - fraction * plotHeight
		}))
	);

	function clockLabel(timestamp: number): string {
		return new Date(timestamp).toLocaleTimeString(undefined, {
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	/** Evenly spaced time labels across the window. */
	const xTicks = $derived(
		[0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
			key: fraction,
			x: PAD_LEFT + fraction * plotWidth,
			label: clockLabel(startsAt + span * fraction),
			anchor: fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'
		}))
	);

	const latest = $derived(visible.length ? visible[visible.length - 1].value : 0);

	/** How much of the window actually has data, so the chart can say so. */
	const coverage = $derived.by(() => {
		if (visible.length < 2) return null;
		const minutes = Math.round(
			(visible[visible.length - 1].timestamp - visible[0].timestamp) / 60000
		);
		if (minutes < 60) return `${minutes} min of data`;
		return `${Math.floor(minutes / 60)}h ${minutes % 60}m of data`;
	});
</script>

<figure class="spark">
	<figcaption>
		<span class="muted small">{label}</span>
		<span class="row">
			{#if coverage}<span class="faint small">{coverage}</span>{/if}
			<span class="mono value">{format(latest)}{unit}</span>
		</span>
	</figcaption>

	{#if path}
		<svg viewBox="0 0 {WIDTH} {height}" role="img" aria-label={label}>
			{#each yTicks as tick (tick.fraction)}
				<line
					x1={PAD_LEFT}
					x2={WIDTH}
					y1={tick.y}
					y2={tick.y}
					class="grid"
					class:baseline={tick.fraction === 0}
				/>
				<text x={PAD_LEFT - 6} y={tick.y + 3} class="axis" text-anchor="end">
					{format(tick.value)}{unit}
				</text>
			{/each}

			{#each xTicks as tick (tick.key)}
				<text x={tick.x} y={height - 5} class="axis" text-anchor={tick.anchor}>{tick.label}</text>
			{/each}

			<path d={area} class="fill" />
			<path d={path} class="line" />
		</svg>
	{:else}
		<p class="faint small no-data">Not enough samples yet.</p>
	{/if}
</figure>

<style>
	.spark {
		margin: 0;
	}

	figcaption {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: var(--space-2);
	}

	.value {
		font-size: 1.05rem;
		color: var(--text);
	}

	svg {
		display: block;
		width: 100%;
		height: auto;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}

	.line {
		fill: none;
		stroke: var(--accent);
		stroke-width: 1.5;
		vector-effect: non-scaling-stroke;
	}

	.fill {
		fill: color-mix(in srgb, var(--accent) 16%, transparent);
		stroke: none;
	}

	.grid {
		stroke: var(--line);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}

	.grid.baseline {
		stroke: var(--line-strong);
	}

	.axis {
		fill: var(--text-faint);
		font-family: var(--font-mono);
		font-size: 9px;
	}

	.no-data {
		border: 1px dashed var(--line);
		border-radius: var(--radius);
		padding: var(--space-4);
		text-align: center;
		margin: 0;
	}
</style>
