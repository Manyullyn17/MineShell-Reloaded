<script lang="ts">
	import type { Snippet } from 'svelte';
	import { UPDATE_CHANNEL_LABELS, UPDATE_CHANNELS, UPDATE_CHECK_HOURS } from '#lib/shared/updatecheck.js';

	/** Update check fields, shared by an instance's settings and the new-server defaults. */
	type UpdateValues = { updateCheck: boolean; updateCheckHours: number; updateChannel: string };
	let { values = $bindable(), channelHint }: { values: UpdateValues; channelHint?: Snippet } = $props();
</script>

<div class="check field">
	<input id="updateCheck" name="updateCheck" type="checkbox" bind:checked={values.updateCheck} />
	<label for="updateCheck">Check for updates</label>
</div>
<div class="grid-2">
	<div class="field">
		<label for="updateCheckHours">How often</label>
		<select id="updateCheckHours" name="updateCheckHours" bind:value={values.updateCheckHours} disabled={!values.updateCheck}>
			{#each UPDATE_CHECK_HOURS as option (option.hours)}
				<option value={option.hours}>{option.label}</option>
			{/each}
		</select>
	</div>
	<div class="field">
		<label for="updateChannel">Offer</label>
		<select id="updateChannel" name="updateChannel" bind:value={values.updateChannel} disabled={!values.updateCheck}>
			{#each UPDATE_CHANNELS as channel (channel)}
				<option value={channel}>{UPDATE_CHANNEL_LABELS[channel]}</option>
			{/each}
		</select>
		{@render channelHint?.()}
	</div>
</div>
{#if !values.updateCheck}
	<!-- A disabled select is not posted; the saved values go with the switch. -->
	<input type="hidden" name="updateCheckHours" value={values.updateCheckHours} />
	<input type="hidden" name="updateChannel" value={values.updateChannel} />
{/if}
