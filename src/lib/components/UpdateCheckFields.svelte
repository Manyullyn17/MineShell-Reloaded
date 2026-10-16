<script lang="ts">
	import type { Snippet } from 'svelte';
	import SegmentedChoice from './SegmentedChoice.svelte';
	import { channelLabel, channelsFor, UPDATE_CHECK_HOURS, type UpdateChannel } from '#lib/shared/updatecheck.js';

	/** Update check fields, shared by an instance's settings and the new-server defaults. */
	type UpdateValues = { updateCheck: boolean; updateCheckHours: number; updateChannel: string; modUpdateCheck: boolean };
	let {
		values = $bindable(),
		channelHint,
		loader = null,
		mods = false
	}: {
		values: UpdateValues;
		channelHint?: Snippet;
		/** For a server checked for loader builds: Forge's channels are its recommended build and newer ones. */
		loader?: string | null;
		/** Show "Include mods": servers without a pack, and the new-server defaults. */
		mods?: boolean;
	} = $props();

	const channels = $derived(channelsFor(loader));
	const channelChoices = $derived([
		...channels.map((channel) => ({ value: channel as string, label: channelLabel(channel, loader) })),
		// A setting from the new-server defaults that this loader has no name for (alphas, on Forge).
		...(channels.includes(values.updateChannel as UpdateChannel)
			? []
			: [{ value: values.updateChannel, label: channelLabel(values.updateChannel as UpdateChannel, null) }])
	]);
</script>

<div class="check field">
	<input id="updateCheck" name="updateCheck" type="checkbox" class="switch" role="switch" bind:checked={values.updateCheck} />
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
		<span class="label" id="updateChannel-label">Offer</span>
		<div class="control">
			<SegmentedChoice
				options={channelChoices}
				bind:value={values.updateChannel}
				name="updateChannel"
				labelledby="updateChannel-label"
				disabled={!values.updateCheck}
			/>
		</div>
		{@render channelHint?.()}
	</div>
</div>
{#if mods}
	<div class="check field">
		<input id="modUpdateCheck" name="modUpdateCheck" type="checkbox" class="switch" role="switch" bind:checked={values.modUpdateCheck} disabled={!values.updateCheck} />
		<label for="modUpdateCheck">Include mods</label>
	</div>
	<p class="hint">
		Servers without a pack: the check also looks for newer builds of the Modrinth and CurseForge mods (releases stay on
		releases). A pack's mods change with the pack, and the Mods tab can still check them by hand.
	</p>
{/if}
{#if !values.updateCheck}
	<!-- Disabled fields are not posted; the saved values go with the switch. -->
	<input type="hidden" name="updateCheckHours" value={values.updateCheckHours} />
	<input type="hidden" name="updateChannel" value={values.updateChannel} />
{/if}
{#if (!values.updateCheck || !mods) && values.modUpdateCheck}
	<input type="hidden" name="modUpdateCheck" value="on" />
{/if}
