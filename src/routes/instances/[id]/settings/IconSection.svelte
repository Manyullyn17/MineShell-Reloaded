<script lang="ts">
	import { dropzone } from '#lib/shared/dropzone.js';
	import { applyPackIcon, toServerIcon } from '#lib/shared/servericon.js';
	import SettingsSection from '#lib/components/SettingsSection.svelte';

	let {
		instanceId,
		hasIcon: hadIcon,
		packIcon,
		editable
	}: {
		instanceId: string;
		hasIcon: boolean;
		/** The server came from a pack with a project, whose icon can be used. */
		packIcon: boolean;
		editable: boolean;
	} = $props();

	// ---- scaled to the 64x64 PNG Minecraft wants, here in the browser
	const iconUrl = $derived(`/api/instances/${encodeURIComponent(instanceId)}/icon`);
	// svelte-ignore state_referenced_locally
	let hasIcon = $state(hadIcon);
	let iconVersion = $state(0);
	let iconError = $state('');

	async function pickIcon(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		iconError = '';
		try {
			const res = await fetch(iconUrl, { method: 'PUT', body: await toServerIcon(file) });
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Upload failed.');
			hasIcon = true;
			iconVersion++;
		} catch (err) {
			iconError = err instanceof Error ? err.message : 'Upload failed.';
		}
	}

	async function usePackIcon() {
		iconError = '';
		try {
			await applyPackIcon(instanceId);
			hasIcon = true;
			iconVersion++;
		} catch (err) {
			iconError = err instanceof Error ? err.message : 'Could not use the pack icon.';
		}
	}

	async function removeIcon() {
		iconError = '';
		const res = await fetch(iconUrl, { method: 'DELETE' });
		if (res.ok) hasIcon = false;
		else iconError = 'Could not remove the icon.';
	}
</script>

<SettingsSection tab="general" title="Server icon" {editable} description="Shown next to the server in players' server lists.">
	<div class="block icon-block" use:dropzone={{ label: 'Drop an image to use as the icon' }}>
		{#if hasIcon}
			<img src="{iconUrl}?v={iconVersion}" alt="Server icon" width="64" height="64" />
		{:else}
			<div class="icon-placeholder" aria-hidden="true">?</div>
		{/if}
		<p class="muted small grow">
			Any image works. It is cropped to a square and scaled to the 64×64 PNG Minecraft needs. Takes effect on the next
			start.
		</p>
		<div class="button-row">
			<label class="button">
				{hasIcon ? 'Replace' : 'Choose an image'}
				<input type="file" accept="image/*" class="visually-hidden" onchange={pickIcon} />
			</label>
			{#if packIcon}<button class="button-quiet" type="button" onclick={usePackIcon}>Use the pack's icon</button>{/if}
			{#if hasIcon}<button class="button-quiet" type="button" onclick={removeIcon}>Remove</button>{/if}
		</div>
	</div>
	{#if iconError}<p class="hint warn-text">{iconError}</p>{/if}
</SettingsSection>

<style>
	.icon-block {
		display: flex;
		align-items: center;
		gap: 1.1rem;
	}

	.icon-block img,
	.icon-placeholder {
		width: 64px;
		height: 64px;
		flex: none;
		border-radius: var(--radius);
		image-rendering: pixelated;
	}

	.icon-placeholder {
		display: grid;
		place-items: center;
		border: 1px dashed var(--line-strong);
		color: var(--text-muted);
	}

	.grow {
		flex: 1;
		margin: 0;
	}

	.warn-text {
		color: var(--warning);
	}

	@media (max-width: 60rem) {
		.icon-block {
			display: grid;
			grid-template-columns: 64px minmax(0, 1fr);
			align-items: start;
			gap: var(--space-3);
		}

		.icon-block > p {
			min-width: 0;
			grid-column: 1 / -1;
			grid-row: 2;
		}

		.icon-block > .button-row {
			grid-column: 1 / -1;
			flex-wrap: wrap;
		}
	}
</style>
