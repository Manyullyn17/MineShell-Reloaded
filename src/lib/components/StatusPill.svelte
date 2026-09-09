<script lang="ts">
	import { describeState } from '$lib/shared/format';

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
		gap: 0.4rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.pill[data-tone='running'] {
		color: var(--success);
	}
	.pill[data-tone='failed'] {
		color: var(--error);
	}
	.pill[data-tone='busy'] {
		color: var(--warning);
	}
	.compact {
		font-size: 0.78rem;
	}
</style>
