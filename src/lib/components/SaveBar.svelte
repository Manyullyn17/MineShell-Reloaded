<script lang="ts">
	/**
	 * The save bar pinned to the bottom of a settings page: what changed, Discard and Save.
	 * MineShell settings and its New server defaults; a server's Settings has its own (restart choices).
	 * Without `onSave`, Save is the submit button of the form the bar sits in.
	 */
	let {
		changed,
		saving = false,
		onDiscard,
		onSave,
		saveLabel = 'Save'
	}: {
		/** Names of the changed sections. */
		changed: string[];
		saving?: boolean;
		onDiscard: () => void;
		onSave?: () => void;
		saveLabel?: string;
	} = $props();
</script>

<div class="savebar" class:dirty={changed.length > 0}>
	<span class="summary">
		{#if changed.length}
			<span class="wide">Changed: {changed.join(', ')}</span>
			<span class="narrow">{changed.length} section{changed.length === 1 ? '' : 's'} changed</span>
		{:else}
			No unsaved changes
		{/if}
	</span>
	{#if changed.length}
		<div class="button-row">
			<button type="button" class="button-quiet" onclick={onDiscard} disabled={saving}>Discard</button>
			<button type={onSave ? 'button' : 'submit'} class="button-primary" onclick={onSave} disabled={saving}>
				{saving ? 'Saving' : saveLabel}
			</button>
		</div>
	{/if}
</div>

<style>
	.savebar {
		position: sticky;
		bottom: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		margin: var(--space-5) -2.5rem calc(var(--space-5) * -1);
		padding: 0.75rem 2.5rem;
		min-height: 4rem;
		border-top: 1px solid var(--line);
		background: var(--bg);
		color: var(--text-faint);
		font-size: 0.92rem;
	}

	.savebar.dirty {
		color: var(--warning);
		background: color-mix(in srgb, var(--warning) 7%, var(--bg));
	}

	.summary {
		min-width: 0;
	}

	.narrow {
		display: none;
	}

	@media (max-width: 60rem) {
		/* One short line, then the buttons side by side across the width. */
		.savebar {
			flex-wrap: wrap;
			gap: 0.5rem;
			min-height: 0;
			margin: var(--space-4) calc(var(--space-4) * -1) calc(var(--space-4) * -1);
			padding: 0.6rem var(--space-4) calc(0.6rem + env(safe-area-inset-bottom));
			font-size: 0.85rem;
		}

		/* Nothing to save: no bar taking room at the bottom of a phone. */
		.savebar:not(.dirty) {
			display: none;
		}

		.summary {
			width: 100%;
		}

		.wide {
			display: none;
		}

		.narrow {
			display: inline;
		}

		.button-row {
			display: grid;
			grid-auto-flow: column;
			grid-auto-columns: minmax(0, 1fr);
			gap: 0.5rem;
			width: 100%;
		}

		.button-row button {
			width: 100%;
			margin: 0;
		}
	}
</style>
