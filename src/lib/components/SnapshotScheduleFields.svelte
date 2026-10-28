<script lang="ts">
	import PresetSelect from './PresetSelect.svelte';
	import WarnChoice from './WarnChoice.svelte';
	import { EVERY_HOURS, unevenHours } from '#lib/shared/presets.js';
	import type { Snippet } from 'svelte';

	/**
	 * Scheduled snapshot fields, shared by a server's Settings and the new-server defaults. Field
	 * names are what scheduleFromForm reads; fields hidden by the choice still post their value.
	 */
	type ScheduleValues = {
		snapshotEvery: string;
		snapshotDailyTime: string;
		snapshotIntervalHours: number;
		snapshotWhileRunning: string;
		snapshotWarnMinutes: number;
		snapshotSkipIdle: boolean;
	};
	let {
		values = $bindable(),
		status
	}: {
		values: ScheduleValues;
		/** Under the choice: a server's next and last scheduled snapshot. */
		status?: Snippet;
	} = $props();
</script>

<div class="field">
	<label for="snapshotEvery">Take one</label>
	<select id="snapshotEvery" name="snapshotEvery" bind:value={values.snapshotEvery}>
		<option value="off">Never</option>
		<option value="daily">At a fixed time each day</option>
		<option value="interval">Every few hours</option>
	</select>
	{@render status?.()}
</div>
{#if values.snapshotEvery === 'daily'}
	<div class="field">
		<label for="snapshotDailyTime">At</label>
		<input id="snapshotDailyTime" name="snapshotDailyTime" type="time" bind:value={values.snapshotDailyTime} />
	</div>
{:else}
	<input type="hidden" name="snapshotDailyTime" value={values.snapshotDailyTime} />
{/if}
{#if values.snapshotEvery === 'interval'}
	<div class="field">
		<label for="snapshotIntervalHours">How often</label>
		<PresetSelect id="snapshotIntervalHours" name="snapshotIntervalHours" choices={EVERY_HOURS} other={unevenHours} bind:value={values.snapshotIntervalHours} />
		<p class="hint">On the clock: every hour at :00; every 6 hours at 0:00, 6:00, 12:00 and 18:00.</p>
	</div>
{:else}
	<input type="hidden" name="snapshotIntervalHours" value={values.snapshotIntervalHours} />
{/if}
{#if values.snapshotEvery !== 'off'}
	<div class="field">
		<label for="snapshotWhileRunning">When the server is running</label>
		<select id="snapshotWhileRunning" name="snapshotWhileRunning" bind:value={values.snapshotWhileRunning}>
			<option value="live">Copy it while it runs</option>
			<option value="stop">Stop it, copy, start it again</option>
		</select>
		<p class="hint">
			{#if values.snapshotWhileRunning === 'live'}
				Saving is paused for the copy (save-off, save-all), then turned back on; players keep playing. A mod that
				writes its own files outside the world's saves can still be caught mid-write.
			{:else}
				Players are warned first, like a scheduled restart. It starts again as soon as the copy is done, also if the
				copy failed. A stopped server is copied as it is either way.
			{/if}
		</p>
	</div>
	{#if values.snapshotWhileRunning === 'stop'}
		<div class="field">
			<span class="label" id="snapshotWarnMinutes-label">Warn players ahead</span>
			<div class="control">
				<WarnChoice name="snapshotWarnMinutes" labelledby="snapshotWarnMinutes-label" bind:value={values.snapshotWarnMinutes} />
			</div>
		</div>
	{:else}
		<input type="hidden" name="snapshotWarnMinutes" value={values.snapshotWarnMinutes} />
	{/if}
	<div class="check field">
		<input id="snapshotSkipIdle" name="snapshotSkipIdle" type="checkbox" class="switch" role="switch" bind:checked={values.snapshotSkipIdle} />
		<label for="snapshotSkipIdle">Skip when nobody was online since the last snapshot</label>
	</div>
	<div class="field">
		<p class="hint">
			Saves space: an empty server's world rarely changes. But chunk loaders keep farms and machines running
			with nobody on, and those changes then wait for the next snapshot someone played before.
		</p>
	</div>
{:else}
	<input type="hidden" name="snapshotWhileRunning" value={values.snapshotWhileRunning} />
	<input type="hidden" name="snapshotWarnMinutes" value={values.snapshotWarnMinutes} />
	{#if values.snapshotSkipIdle}<input type="hidden" name="snapshotSkipIdle" value="on" />{/if}
{/if}
