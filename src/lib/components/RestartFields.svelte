<script lang="ts">
	/**
	 * Crash and scheduled restart fields, shared by an instance's settings and
	 * the new-server defaults. Field names are what restartsFromForm reads.
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
	};
	let { values = $bindable() }: { values: RestartValues } = $props();
</script>

<fieldset>
	<legend>After a crash</legend>
	<div class="check field">
		<input
			id="autoRestartOnCrash"
			name="autoRestartOnCrash"
			type="checkbox"
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
			<label for="crashRestartWindowSec">Counted over (seconds)</label>
			<input id="crashRestartWindowSec" name="crashRestartWindowSec" type="number" min="60" max="86400" step="60" bind:value={values.crashRestartWindowSec} />
			<p class="hint">A crash loop trips the limit; occasional crashes reset it.</p>
		</div>
	</div>
</fieldset>

<fieldset>
	<legend>On a schedule</legend>
	<div class="field">
		<label for="restartSchedule">Restart</label>
		<select id="restartSchedule" name="restartSchedule" bind:value={values.restartSchedule}>
			<option value="none">Never</option>
			<option value="interval">Every few hours</option>
			<option value="daily">At a fixed time each day</option>
		</select>
	</div>

	{#if values.restartSchedule === 'interval'}
		<div class="field">
			<label for="restartIntervalHours">Hours between restarts</label>
			<input id="restartIntervalHours" name="restartIntervalHours" type="number" min="1" max="168" bind:value={values.restartIntervalHours} />
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
			<label for="restartWarnMinutes">Warn players this many minutes ahead</label>
			<input id="restartWarnMinutes" name="restartWarnMinutes" type="number" min="0" max="60" bind:value={values.restartWarnMinutes} />
			<p class="hint">Sends in-game messages at 15, 10, 5 and 1 minutes, within this window. 0 sends nothing.</p>
		</div>
		<div class="check field">
			<input
				id="restartSkipIfPlayers"
				name="restartSkipIfPlayers"
				type="checkbox"
				bind:checked={values.restartSkipIfPlayers}
			/>
			<label for="restartSkipIfPlayers">
				Wait while players are online, up to an hour past the scheduled time
			</label>
		</div>
	{/if}
</fieldset>
