<script lang="ts">
	import SegmentedChoice from './SegmentedChoice.svelte';
	import PresetSelect from './PresetSelect.svelte';
	import WarnChoice from './WarnChoice.svelte';
	import { CRASH_WINDOWS, EVERY_HOURS, unevenHours, windowLabel } from '#lib/shared/presets.js';

	/**
	 * Crash, scheduled and after-reboot start fields, shared by an instance's
	 * settings and the new-server defaults. Field names are what
	 * restartsFromForm reads.
	 */
	type RestartValues = {
		autoRestartOnCrash: boolean;
		crashRestartLimit: number;
		crashRestartWindowSec: number;
		restartSchedule: string;
		restartIntervalHours: number | null;
		restartDailyTime: string | null;
		restartWarnMinutes: number;
		restartSkipIfPlayers: boolean;
		bootStart: string;
	};
	let {
		values = $bindable(),
		bootNote = null
	}: {
		values: RestartValues;
		/** Shown under the after-reboot choice: why it may not happen (MineShell not started at boot). */
		bootNote?: string | null;
	} = $props();

	const BOOT_CHOICES = [
		{ value: 'if-running', label: 'If it was running' },
		{ value: 'always', label: 'Always' },
		{ value: 'never', label: 'Never' }
	];
	const SCHEDULE_CHOICES = [
		{ value: 'none', label: 'Never' },
		{ value: 'interval', label: 'Every few hours' },
		{ value: 'daily', label: 'Daily' }
	];
</script>

<fieldset>
	<legend>When the computer starts</legend>
	<div class="field">
		<span class="label" id="bootStart-label">Start this server</span>
		<div class="control">
			<SegmentedChoice options={BOOT_CHOICES} bind:value={values.bootStart} name="bootStart" labelledby="bootStart-label" />
		</div>
		<p class="hint">
			MineShell starts these one at a time once it is up after a reboot. "Running before" means the last thing done
			to it was a start: a stop clears it, a crash does not.
		</p>
		{#if bootNote}<p class="hint warn-text">{bootNote}</p>{/if}
	</div>
</fieldset>

<fieldset>
	<legend>After a crash</legend>
	<div class="check field">
		<input
			id="autoRestartOnCrash"
			name="autoRestartOnCrash"
			type="checkbox"
			class="switch"
			role="switch"
			bind:checked={values.autoRestartOnCrash}
		/>
		<label for="autoRestartOnCrash">Bring the server back automatically if it exits badly</label>
	</div>
	<div class="grid-2">
		<div class="field">
			<label for="crashRestartLimit">Give up after</label>
			<input id="crashRestartLimit" name="crashRestartLimit" type="number" min="1" max="50" bind:value={values.crashRestartLimit} />
			<p class="hint">Attempts before systemd stops trying.</p>
		</div>
		<div class="field">
			<label for="crashRestartWindowSec">Counted over</label>
			<PresetSelect id="crashRestartWindowSec" name="crashRestartWindowSec" choices={CRASH_WINDOWS} other={windowLabel} bind:value={values.crashRestartWindowSec} />
			<p class="hint">A crash loop trips the limit; occasional crashes reset it.</p>
		</div>
	</div>
</fieldset>

<fieldset>
	<legend>On a schedule</legend>
	<div class="field">
		<span class="label" id="restartSchedule-label">Restart</span>
		<div class="control">
			<SegmentedChoice options={SCHEDULE_CHOICES} bind:value={values.restartSchedule} name="restartSchedule" labelledby="restartSchedule-label" />
		</div>
	</div>

	{#if values.restartSchedule === 'interval'}
		<div class="field">
			<label for="restartIntervalHours">How often</label>
			<PresetSelect id="restartIntervalHours" name="restartIntervalHours" choices={EVERY_HOURS} other={unevenHours} bind:value={values.restartIntervalHours} />
			<p class="hint">On the clock: every 6 hours restarts at 0:00, 6:00, 12:00 and 18:00.</p>
		</div>
	{/if}

	{#if values.restartSchedule === 'daily'}
		<div class="field">
			<label for="restartDailyTime">Time of day</label>
			<input id="restartDailyTime" name="restartDailyTime" type="time" bind:value={values.restartDailyTime} />
			<p class="hint">In the server machine's local timezone.</p>
		</div>
	{/if}

	{#if values.restartSchedule !== 'none'}
		<div class="field">
			<span class="label" id="restartWarnMinutes-label">Warn players ahead</span>
			<div class="control">
				<WarnChoice name="restartWarnMinutes" labelledby="restartWarnMinutes-label" bind:value={values.restartWarnMinutes} />
			</div>
			<p class="hint">In-game messages at 15, 10, 5 and 1 minutes before, from the one picked.</p>
		</div>
		<div class="check field">
			<input
				id="restartSkipIfPlayers"
				name="restartSkipIfPlayers"
				type="checkbox"
				class="switch"
				role="switch"
				bind:checked={values.restartSkipIfPlayers}
			/>
			<label for="restartSkipIfPlayers">
				Wait while players are online, up to an hour past the scheduled time
			</label>
		</div>
	{:else if values.restartSkipIfPlayers}
		<!-- An absent checkbox reads as off; the saved choice goes with the schedule. -->
		<input type="hidden" name="restartSkipIfPlayers" value="on" />
	{/if}
</fieldset>

<style>
	/* Beats the forms' grey hint colour. */
	.field > p.hint.warn-text {
		color: var(--warning);
	}
</style>
