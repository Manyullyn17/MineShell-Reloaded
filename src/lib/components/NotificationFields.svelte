<script lang="ts">
	import { NOTIFICATION_KINDS, TARGET_TYPES, type NotificationKind, type TargetType } from '#lib/shared/notifications.js';

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
		values: { type: TargetType; kinds: NotificationKind[] };
		/** How the saved address shows ("Discord webhook 1234"), null when none is saved. */
		savedHint: string | null;
		idPrefix: string;
	} = $props();

	const info = $derived(TARGET_TYPES.find((t) => t.type === values.type) ?? TARGET_TYPES[0]);
</script>

<div class="grid-2">
	<div class="field">
		<label for="{idPrefix}-type">Send to</label>
		<select id="{idPrefix}-type" name="type" bind:value={values.type}>
			{#each TARGET_TYPES as t (t.type)}
				<option value={t.type}>{t.label}</option>
			{/each}
		</select>
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
</style>
