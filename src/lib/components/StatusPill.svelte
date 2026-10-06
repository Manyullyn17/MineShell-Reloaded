<script lang="ts">
	import { describeState } from '#lib/shared/format.js';

	let { active, sub, compact = false }: { active: string; sub: string; compact?: boolean } =
		$props();

	const state = $derived(describeState(active, sub));
</script>

<span class="pill" data-tone={state.tone} class:compact>
	<span class="dot {state.tone}"></span>
	<span>{state.label}</span>
</span>

<style>
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.2rem 0.65rem 0.2rem 0.5rem;
		border-radius: var(--radius);
		font-size: 0.85rem;
		font-weight: 500;
		white-space: nowrap;
		color: var(--text-muted);
		background: color-mix(in srgb, var(--text-muted) 12%, transparent);
	}
	.pill .dot {
		background: currentColor;
		animation: none;
	}
	.pill[data-tone='running'] {
		color: var(--accent-hover);
		background: color-mix(in srgb, var(--success) 14%, transparent);
	}
	.pill[data-tone='failed'] {
		color: var(--error);
		background: color-mix(in srgb, var(--error) 14%, transparent);
	}
	.pill[data-tone='busy'] {
		color: var(--warning);
		background: color-mix(in srgb, var(--warning) 14%, transparent);
	}
	.compact {
		font-size: 0.78rem;
	}
</style>
