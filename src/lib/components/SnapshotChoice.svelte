<script lang="ts">
	import { formatBytes } from '$lib/shared/format';

	/**
	 * The snapshot part of a risky operation's form. Below the size threshold
	 * (or with the question turned off) the world is always snapshotted and
	 * this only says so; above it, the person chooses. The server applies the
	 * same rule (decideSnapshot), so a missing choice is refused there too.
	 */
	let {
		prompt,
		idPrefix
	}: {
		prompt: { worldBytes: number; ask: boolean; policy: { keep: number; askAboveMb: number } };
		idPrefix: string;
	} = $props();
</script>

{#if prompt.worldBytes > 0}
	{#if prompt.ask}
		<fieldset class="snapshot">
			<legend>World snapshot ({formatBytes(prompt.worldBytes)})</legend>
			<div class="check">
				<input id="{idPrefix}-snap-yes" type="radio" name="snapshot" value="yes" checked />
				<label for="{idPrefix}-snap-yes">Copy the world first, so it can be restored from the World tab</label>
			</div>
			<div class="check">
				<input id="{idPrefix}-snap-no" type="radio" name="snapshot" value="no" />
				<label for="{idPrefix}-snap-no">Continue without a snapshot</label>
			</div>
		</fieldset>
	{:else}
		<p class="hint">
			The world ({formatBytes(prompt.worldBytes)}) is copied to a snapshot first; the newest {prompt.policy.keep}
			are kept, on the World tab.
		</p>
	{/if}
{/if}

<style>
	.snapshot {
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
		margin: var(--space-3) 0;
	}

	.snapshot legend {
		font-size: 0.88rem;
		padding: 0 var(--space-1);
	}
</style>
