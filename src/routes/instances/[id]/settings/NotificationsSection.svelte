<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import { formatDateTime } from '#lib/shared/format.js';
	import { DEFAULT_NOTIFICATION_KINDS, NOTIFICATION_KINDS, quietValues, type TargetType } from '#lib/shared/notifications.js';
	import SettingsSection from '#lib/components/SettingsSection.svelte';
	import NotificationFields from '#lib/components/NotificationFields.svelte';
	import type { PageData } from './$types';

	let { notifications, editable }: { notifications: PageData['notifications']; editable: boolean } = $props();

	// Re-synced after a save, like the page's other bound fields.
	const notificationValues = () => ({
		type: (notifications.own?.type ?? notifications.global?.type ?? 'discord') as TargetType,
		kinds: [...(notifications.own?.kinds ?? notifications.global?.kinds ?? DEFAULT_NOTIFICATION_KINDS)],
		...quietValues(notifications.own ? notifications.own.quiet : (notifications.global?.quiet ?? null))
	});
	// svelte-ignore state_referenced_locally
	let notifyValues = $state(notificationValues());
	// svelte-ignore state_referenced_locally
	let ownNotifications = $state(!!notifications.own);
	// svelte-ignore state_referenced_locally
	let alsoGlobal = $state(notifications.own?.alsoGlobal ?? false);
	$effect(() => {
		notifyValues = notificationValues();
		ownNotifications = !!notifications.own;
		alsoGlobal = notifications.own?.alsoGlobal ?? false;
	});
	const kindLabels = (kinds: string[]) =>
		NOTIFICATION_KINDS.filter((k) => kinds.includes(k.kind))
			.map((k) => k.label.replace(/ \(.*\)$/, '').toLowerCase())
			.join(', ');
</script>

<SettingsSection tab="automation" id="notifications" title="Notifications" {editable}>
	{#snippet description()}
		{#if notifications.own}
			This server sends to its own destination ({notifications.own.hint}){notifications.own.alsoGlobal &&
			notifications.global
				? `, and to MineShell's (${notifications.global.hint}) for what is ticked there`
				: ''}.
		{:else if notifications.global}
			Sent to MineShell's destination ({notifications.global.hint}) for:
			{kindLabels(notifications.global.kinds) || 'nothing ticked there yet'}. MineShell settings &gt; Notifications
			chooses. Give this server a destination of its own to send it elsewhere.
		{:else}
			MineShell sends no notifications yet (MineShell settings &gt; Notifications). This server can have a destination of
			its own.
		{/if}
	{/snippet}
	{#if notifications.own?.lastResult}
		{@const last = notifications.own.lastResult}
		<p class="small {last.ok ? 'muted' : 'warn-text'}">Last message {formatDateTime(last.at)}: {last.message}</p>
	{/if}
	<div class="check field">
		<input id="ownNotifications" type="checkbox" class="switch" role="switch" bind:checked={ownNotifications} disabled={!!notifications.own} />
		<label for="ownNotifications">Send this server's notifications to a destination of its own</label>
	</div>
	{#if ownNotifications}
		<!-- Reset after saving, so the pasted address does not stay in the field. -->
		<form method="POST" action="?/notifications" use:enhance class="block">
			<NotificationFields bind:values={notifyValues} savedHint={notifications.own?.hint ?? null} idPrefix="server-notify" />
			<div class="check field">
				<input id="alsoGlobal" name="alsoGlobal" type="checkbox" class="switch" role="switch" bind:checked={alsoGlobal} />
				<label for="alsoGlobal">Also send to MineShell's destination, for what is ticked there</label>
			</div>
			<div class="button-row">
				<button class="button-primary" type="submit">Save</button>
				{#if notifications.own}
					<button type="submit" formaction="?/notificationsTest">Send a test message</button>
					<button class="button-quiet" type="submit" formaction="?/notificationsRemove">Remove its own destination</button>
				{/if}
			</div>
		</form>
	{/if}
</SettingsSection>

<style>
	.warn-text {
		color: var(--warning);
	}
</style>
