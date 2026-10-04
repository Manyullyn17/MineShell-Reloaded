<script lang="ts">
	import { formatBytes } from '#lib/shared/format.js';
	import type { SnapshotPromptView } from '#lib/shared/snapshots.js';

	/**
	 * The snapshot part of a risky operation's form. Below the size threshold
	 * (or with the question turned off) the world is always snapshotted and
	 * this only says so; above it, the person chooses. A snapshot that would
	 * copy the world onto a nearly full disk is not offered. The server applies
	 * the same rules (decideSnapshot), so a missing choice is refused there too.
	 *
	 * `moves`: the operation keeps the old world by moving it (the World tab),
	 * which needs no space, so the disk check does not apply.
	 */
	let {
		prompt,
		idPrefix,
		moves = false
	}: {
		prompt: SnapshotPromptView;
		idPrefix: string;
		moves?: boolean;
	} = $props();

	const lowSpace = $derived(prompt.lowSpace && !moves);
	const ask = $derived(moves ? prompt.asksBySize : prompt.ask);
	const keeps = $derived(
		`At least the newest ${prompt.policy.keepMin} are kept, more while they fit in ${formatBytes(prompt.policy.budgetMb * 1024 * 1024)}, plus any pinned.`
	);
</script>

{#if prompt.worldBytes > 0}
	{#if lowSpace}
		<fieldset class="snapshot">
			<legend>World snapshot ({formatBytes(prompt.worldBytes)})</legend>
			<p class="warn small">
				Only {formatBytes(prompt.freeBytes ?? 0)} is free on the disk. A snapshot would leave less than the
				{formatBytes(prompt.policy.minFreeMb * 1024 * 1024)} to keep free, so none is taken. Free some space (old snapshots
				on the World tab, Disk usage under Files) to get one.
			</p>
			<div class="check">
				<input id="{idPrefix}-snap-no" type="radio" name="snapshot" value="no" checked />
				<label for="{idPrefix}-snap-no">Continue without a snapshot</label>
			</div>
		</fieldset>
	{:else if ask}
		<fieldset class="snapshot">
			<legend>World snapshot ({formatBytes(prompt.worldBytes)})</legend>
			<div class="check">
				<input id="{idPrefix}-snap-yes" type="radio" name="snapshot" value="yes" checked />
				<label for="{idPrefix}-snap-yes">Snapshot the current world first</label>
			</div>
			<div class="check">
				<input id="{idPrefix}-snap-no" type="radio" name="snapshot" value="no" />
				<label for="{idPrefix}-snap-no">Continue without a snapshot</label>
			</div>
		</fieldset>
	{:else}
		<p class="hint">
			{moves ? 'What this replaces is kept as a snapshot' : `The world (${formatBytes(prompt.worldBytes)}) is copied to a snapshot first`},
			restorable from the World tab. {keeps}
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

	.warn {
		color: var(--warning);
		margin: 0 0 var(--space-2);
	}
</style>
