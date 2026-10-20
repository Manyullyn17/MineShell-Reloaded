<script lang="ts">
	/**
	 * The snapshot retention fields, shared by the global Settings and a
	 * server's own settings. Values are strings as typed; a blank one means
	 * the default (globally) or the global value (on a server), which
	 * `placeholders` then shows. The question and the free-space check can
	 * also be off ("never", "off"), picked beside the size.
	 */
	import SegmentedChoice from './SegmentedChoice.svelte';

	type Values = {
		keepMin: string;
		keepMax: string;
		partialMin: string;
		partialMax: string;
		budgetGb: string;
		askAboveGb: string;
		minFreeGb: string;
	};
	type Mode = 'global' | 'on' | 'off';
	let {
		values = $bindable(),
		placeholders = null,
		idPrefix
	}: { values: Values; placeholders?: Values | null; idPrefix: string } = $props();

	const SIZE_DEFAULTS = { askAboveGb: '2', minFreeGb: '5' };
	const OFF = { askAboveGb: 'never', minFreeGb: 'off' };
	type SizeKey = keyof typeof OFF;
	const isSize = (v: string | number | undefined) => v !== undefined && v !== '' && !Number.isNaN(Number(v));

	function mode(key: SizeKey): Mode {
		const v = values[key];
		if (v === OFF[key]) return 'off';
		return v === '' && placeholders ? 'global' : 'on';
	}
	function setMode(key: SizeKey, m: Mode) {
		const fallback = placeholders && isSize(placeholders[key]) ? placeholders[key] : SIZE_DEFAULTS[key];
		values[key] = m === 'global' ? '' : m === 'off' ? OFF[key] : isSize(values[key]) ? values[key] : fallback;
	}
	const modes = (on: string, off: string) => [
		...(placeholders ? [{ value: 'global' as Mode, label: 'Global' }] : []),
		{ value: 'on' as Mode, label: on },
		{ value: 'off' as Mode, label: off }
	];
	const globalSays = (key: SizeKey, on: (gb: string) => string, off: string) =>
		placeholders ? (placeholders[key] === OFF[key] ? off : on(placeholders[key])) : '';
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
				<span class="label" id="{idPrefix}-minFreeLabel">Keep free on the disk</span>
				<div class="control">
					<SegmentedChoice
						options={modes('Keep free', "Don't check")}
						labelledby="{idPrefix}-minFreeLabel"
						bind:value={() => mode('minFreeGb'), (m) => setMode('minFreeGb', m)}
					/>
					{#if mode('minFreeGb') === 'on'}
						<div class="size">
							<input id="{idPrefix}-minFree" name="minFreeGb" type="number" min="0" step="0.5" bind:value={values.minFreeGb} aria-labelledby="{idPrefix}-minFreeLabel" />
							<span class="faint">GB</span>
						</div>
					{:else}
						<input type="hidden" name="minFreeGb" value={values.minFreeGb} />
					{/if}
				</div>
				<p class="hint">
					{#if mode('minFreeGb') === 'global'}
						{globalSays('minFreeGb', (gb) => `Global: keep ${gb} GB free.`, 'Global: not checked.')}
					{/if}
					A snapshot that copies the world is not taken when it would leave less free; the form says so and offers to
					continue without.
				</p>
			</div>
			<div class="field">
				<span class="label" id="{idPrefix}-askLabel">Ask first for big worlds</span>
				<div class="control">
					<SegmentedChoice
						options={modes('Above a size', 'Never')}
						labelledby="{idPrefix}-askLabel"
						bind:value={() => mode('askAboveGb'), (m) => setMode('askAboveGb', m)}
					/>
					{#if mode('askAboveGb') === 'on'}
						<div class="size">
							<input id="{idPrefix}-ask" name="askAboveGb" type="number" min="0" step="0.5" bind:value={values.askAboveGb} aria-labelledby="{idPrefix}-askLabel" />
							<span class="faint">GB</span>
						</div>
					{:else}
						<input type="hidden" name="askAboveGb" value={values.askAboveGb} />
					{/if}
				</div>
				<p class="hint">
					{#if mode('askAboveGb') === 'global'}
						{globalSays('askAboveGb', (gb) => `Global: above ${gb} GB.`, 'Global: never.')}
					{/if}
					Bigger worlds ask whether to snapshot or continue without. Never asking means the snapshot is always taken.
				</p>
			</div>
		</div>
	</fieldset>
</div>

<style>
	.policy fieldset {
		margin-bottom: var(--space-3);
	}
	.control {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
	}
	/* A server's settings rows put controls on the right (SettingsSection). */
	:global(.rows) .control {
		align-items: flex-end;
	}
	@media (max-width: 60rem) {
		:global(.rows) .control {
			align-items: flex-start;
		}
	}
	:global(.rows) .size input {
		text-align: right;
	}
	.size {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
	.size input {
		max-width: 8rem;
	}
</style>
