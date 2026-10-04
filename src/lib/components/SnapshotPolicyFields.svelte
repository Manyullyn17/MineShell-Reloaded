<script lang="ts">
	/**
	 * The snapshot retention fields, shared by the global Settings and a
	 * server's own settings. Values are strings as typed; a blank one means
	 * the default (globally) or the global value (on a server), which
	 * `placeholders` then shows.
	 */
	type Values = {
		keepMin: string;
		keepMax: string;
		partialMin: string;
		partialMax: string;
		budgetGb: string;
		askAboveMb: string;
		minFreeGb: string;
	};
	let {
		values = $bindable(),
		placeholders = null,
		idPrefix
	}: { values: Values; placeholders?: Values | null; idPrefix: string } = $props();
</script>

<div class="policy">
	<fieldset>
		<legend>How many</legend>
		<div class="grid-2">
			<div class="field">
				<label for="{idPrefix}-keepMin">Full snapshots always kept</label>
				<input id="{idPrefix}-keepMin" name="keepMin" type="number" min="1" bind:value={values.keepMin} placeholder={placeholders?.keepMin} />
			</div>
			<div class="field">
				<label for="{idPrefix}-keepMax">Full snapshots at most</label>
				<input id="{idPrefix}-keepMax" name="keepMax" type="number" min="1" bind:value={values.keepMax} placeholder={placeholders?.keepMax} />
			</div>
			<div class="field">
				<label for="{idPrefix}-partialMin">Partial snapshots always kept</label>
				<input id="{idPrefix}-partialMin" name="partialMin" type="number" min="0" bind:value={values.partialMin} placeholder={placeholders?.partialMin} />
			</div>
			<div class="field">
				<label for="{idPrefix}-partialMax">Partial snapshots at most</label>
				<input id="{idPrefix}-partialMax" name="partialMax" type="number" min="0" bind:value={values.partialMax} placeholder={placeholders?.partialMax} />
			</div>
		</div>
		<p class="faint small">
			Partial snapshots hold one dimension, taken before it is reset, restored or pruned. They are counted apart, so they
			never push out the last full worlds.
		</p>
	</fieldset>
	<fieldset>
		<legend>Space</legend>
		<div class="grid-2">
			<div class="field">
				<label for="{idPrefix}-budget">Keep more while they fit in (GB per server)</label>
				<input id="{idPrefix}-budget" name="budgetGb" type="number" min="0" step="0.5" bind:value={values.budgetGb} placeholder={placeholders?.budgetGb} />
				<p class="hint">
					Beyond the ones always kept, newest first, full and partial together. Sizes are file sizes; on btrfs or XFS
					snapshots share space with the world and take less.
				</p>
			</div>
			<div class="field">
				<label for="{idPrefix}-minFree">Keep free on the disk (GB)</label>
				<input id="{idPrefix}-minFree" name="minFreeGb" type="number" min="0" step="0.5" bind:value={values.minFreeGb} placeholder={placeholders?.minFreeGb} />
				<p class="hint">
					A snapshot that copies the world is not taken when it would leave less free; the form says so and offers to
					continue without. <code>0</code> turns this off.
				</p>
			</div>
			<div class="field">
				<label for="{idPrefix}-ask">Ask first for worlds above (MB)</label>
				<input id="{idPrefix}-ask" name="askAboveMb" type="number" min="-1" bind:value={values.askAboveMb} placeholder={placeholders?.askAboveMb} />
				<p class="hint">
					Bigger worlds ask whether to snapshot or continue without. <code>-1</code> turns the question off: the snapshot
					is then always taken.
				</p>
			</div>
		</div>
	</fieldset>
</div>

<style>
	.policy fieldset {
		margin-bottom: var(--space-3);
	}
</style>
