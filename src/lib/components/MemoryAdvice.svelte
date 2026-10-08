<script lang="ts">
	import type { MemoryAdvice } from '#lib/shared/memoryadvice.js';
	import { formatDateTime } from '#lib/shared/format.js';

	/**
	 * Memory advice (memoryadvice.ts) in words. `onUse` adds a button that puts
	 * the suggestion in the memory field (Settings); `settingsHref` a link there
	 * (the overview). Quiet kinds (not enough data, fine) show only with `all`.
	 */
	let {
		advice,
		all = false,
		onUse,
		settingsHref
	}: { advice: MemoryAdvice; all?: boolean; onUse?: (mb: number) => void; settingsHref?: string } = $props();

	const gb = (mb: number) => `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
	const suggested = $derived(advice.kind === 'more' || advice.kind === 'less' ? advice.suggestedMb : null);
</script>

{#if advice.kind === 'more' || advice.kind === 'less' || all}
	<div class="advice" data-kind={advice.kind}>
		<p>
			{#if advice.kind === 'unknown'}
				Memory advice comes after about 6 hours of this server running; MineShell reads how much of its heap Java uses
				once a minute ({advice.hours} hour{advice.hours === 1 ? '' : 's'} so far).
			{:else if advice.kind === 'ok'}
				At its busiest it holds about {gb(advice.neededMb)} after Java cleans up; {gb(advice.currentMb)} fits that well.
			{:else if advice.kind === 'more' && advice.reason === 'out-of-memory'}
				<strong>Ran out of memory</strong> on {formatDateTime(advice.oomAt)} (java.lang.OutOfMemoryError).
				{#if advice.suggestedMb}Give it {gb(advice.suggestedMb)} instead of {gb(advice.currentMb)}.{:else}This machine has no more room to
					give it; fewer mods, or a smaller view distance, use less.{/if}
			{:else if advice.kind === 'more'}
				<strong>Short on memory:</strong> even right after Java cleans up it holds {gb(advice.neededMb ?? 0)} of its heap, so it cleans up
				constantly, which shows as lag.
				{#if advice.suggestedMb}Give it {gb(advice.suggestedMb)} instead of {gb(advice.currentMb)}.{:else}This machine has no more room to
					give it.{/if}
			{:else if advice.kind === 'less'}
				<strong>More memory than it uses:</strong> at its busiest it holds about {gb(advice.neededMb)} after Java cleans up, out of
				{gb(advice.currentMb)}. {gb(advice.suggestedMb)} would do, and leaves the rest to the machine (a smaller heap also means shorter
				clean-ups).
			{/if}
		</p>
		{#if suggested && onUse}
			<button type="button" class="button-quiet" onclick={() => onUse(suggested)}>Use {gb(suggested)}</button>
		{:else if suggested && settingsHref}
			<a class="button button-quiet" href={settingsHref}>Change it</a>
		{/if}
	</div>
{/if}

<style>
	.advice {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--line);
		border-left: 3px solid var(--text-faint);
		border-radius: var(--radius);
		background: var(--bg-sunken);
		font-size: 0.88rem;
	}

	.advice[data-kind='more'] {
		border-left-color: var(--warning);
	}

	.advice[data-kind='less'] {
		border-left-color: var(--info);
	}

	.advice[data-kind='ok'] {
		border-left-color: var(--accent);
	}

	.advice p {
		margin: 0;
		flex: 1;
		color: var(--text-muted);
	}

	.advice strong {
		color: var(--text);
		font-weight: 500;
	}

	.advice button,
	.advice .button {
		flex: none;
	}

	@media (max-width: 60rem) {
		.advice {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
