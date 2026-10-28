<script lang="ts">
	import SegmentedChoice from './SegmentedChoice.svelte';
	import { NOTIFICATION_KINDS, QUIET_KINDS, TARGET_TYPES, type NotificationKind, type TargetType } from '#lib/shared/notifications.js';

	/**
	 * Where notifications go and which are sent, shared by MineShell settings
	 * and a server's Settings. The saved address never comes back to the
	 * browser: the field starts empty, and empty keeps it.
	 */
	let {
		values = $bindable(),
		savedHint,
		idPrefix
	}: {
		values: { type: TargetType; kinds: NotificationKind[]; quietOn: boolean; quietFrom: string; quietTo: string };
		/** How the saved address shows ("Discord webhook 1234"), null when none is saved. */
		savedHint: string | null;
		idPrefix: string;
	} = $props();

	const typeChoices = TARGET_TYPES.map((t) => ({ value: t.type, label: t.label }));
	const info = $derived(TARGET_TYPES.find((t) => t.type === values.type) ?? TARGET_TYPES[0]);
	const quietLabels = NOTIFICATION_KINDS.filter((k) => QUIET_KINDS.includes(k.kind))
		.map((k) => k.label.toLowerCase())
		.join(', ');
</script>

<div class="grid-2">
	<div class="field">
		<span class="label" id="{idPrefix}-type-label">Send to</span>
		<SegmentedChoice options={typeChoices} bind:value={values.type} name="type" labelledby="{idPrefix}-type-label" />
	</div>
	<div class="field">
		<label for="{idPrefix}-url">Address</label>
		<input
			id="{idPrefix}-url"
			name="url"
			type="text"
			autocomplete="off"
			spellcheck="false"
			data-1p-ignore
			data-lpignore="true"
			data-bwignore
			data-save-clear
			placeholder={savedHint ? `Saved: ${savedHint}. Paste a new one to replace it.` : info.placeholder}
		/>
	</div>
</div>
<p class="hint">{info.hint} The address is stored encrypted and never shown again.</p>

<fieldset class="kinds">
	<legend>Send a message when a server</legend>
	{#each NOTIFICATION_KINDS as k (k.kind)}
		<div class="check field">
			<input id="{idPrefix}-{k.kind}" type="checkbox" class="switch" role="switch" name="kinds" value={k.kind} bind:group={values.kinds} />
			<label for="{idPrefix}-{k.kind}">{k.label}</label>
		</div>
	{/each}
</fieldset>

<div class="check field quiet-switch">
	<input id="{idPrefix}-quiet" name="quietOn" type="checkbox" class="switch" role="switch" bind:checked={values.quietOn} />
	<label for="{idPrefix}-quiet">Quiet hours</label>
</div>
{#if values.quietOn}
	<div class="quiet-times">
		<label>From <input name="quietFrom" type="time" required bind:value={values.quietFrom} /></label>
		<label>to <input name="quietTo" type="time" required bind:value={values.quietTo} /></label>
	</div>
{/if}
<p class="hint">
	During quiet hours (on this machine's clock) these are not sent, then or afterwards: {quietLabels}. Problems and
	updates still are.
</p>

<style>
	.kinds {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: 0 var(--space-4);
		margin-top: var(--space-3);
	}

	.kinds legend {
		margin-bottom: var(--space-2);
	}

	.quiet-switch {
		margin-top: var(--space-3);
	}

	.quiet-times {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
	}
</style>
