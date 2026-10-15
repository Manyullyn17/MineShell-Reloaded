<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import SettingsSection from '#lib/components/SettingsSection.svelte';

	let {
		name,
		busy,
		running,
		mayCopy,
		mayDelete,
		mayGrant
	}: {
		name: string;
		/** Still being installed. */
		busy: boolean;
		running: boolean;
		mayCopy: boolean;
		mayDelete: boolean;
		/** May hand out access: the copy can get the same people. */
		mayGrant: boolean;
	} = $props();

	let showClone = $state(false);
	let showDelete = $state(false);
	let confirmName = $state('');
</script>

{#if mayCopy || mayDelete}
<SettingsSection tab="general" title={mayCopy && mayDelete ? 'Copy or delete' : mayCopy ? 'Copy' : 'Delete'}>
	<div class="danger-box">
		{#if mayCopy}
		<div class="danger-row">
			<div>
				<div class="strong">Copy this server</div>
				<div class="muted small">
					Same files, mods and settings on its own ports, to try a pack update or a migration on first. Snapshots are
					not copied.
				</div>
			</div>
			{#if !showClone}<button type="button" onclick={() => (showClone = true)}>Copy server</button>{/if}
		</div>
		{#if showClone}
			<form method="POST" action="?/clone" use:enhance class="danger-form">
				<div class="field">
					<label for="clone-name">Name of the copy</label>
					<input id="clone-name" name="name" value="{name} (copy)" maxlength="80" required />
				</div>
				{#if mayGrant}
					<div class="check field">
						<input id="clone-access" name="copyAccess" type="checkbox" />
						<label for="clone-access">Give the same people the same access to the copy</label>
						<p class="hint">Otherwise only you, the owner and MineShell admins can use it.</p>
					</div>
				{/if}
				{#if busy || running}
					<p class="hint">Stop the server to copy it; a running server's world is still being written.</p>
				{/if}
				<div class="button-row">
					<button class="button-primary" type="submit" disabled={running || busy}>
						Copy
					</button>
					<button class="button-quiet" type="button" onclick={() => (showClone = false)}>Cancel</button>
				</div>
			</form>
		{/if}
		{/if}
		{#if mayDelete}
		<div class="danger-row bad">
			<div>
				<div class="strong">Delete this server</div>
				<div class="muted small">Stops it, removes its systemd unit and optionally every file, the world included.</div>
			</div>
			{#if !showDelete}
				<button class="button-danger" type="button" onclick={() => (showDelete = true)}>Delete server</button>
			{/if}
		</div>
		{#if showDelete}
			<form method="POST" action="?/delete" use:enhance class="danger-form bad">
				<div class="field">
					<label for="confirm">
						Type <strong>DELETE</strong> to confirm you want to remove <strong>{name}</strong>
					</label>
					<input id="confirm" name="confirm" bind:value={confirmName} autocomplete="off" placeholder="DELETE" />
				</div>
				<div class="check field">
					<input id="deleteFiles" name="deleteFiles" type="checkbox" />
					<label for="deleteFiles">Also delete every file, including the world. This cannot be undone.</label>
				</div>
				<div class="button-row">
					<button class="button-danger" type="submit" disabled={confirmName.trim().toUpperCase() !== 'DELETE'}>
						Delete permanently
					</button>
					<button class="button-quiet" type="button" onclick={() => (showDelete = false)}>Cancel</button>
				</div>
			</form>
		{/if}
		{/if}
	</div>
</SettingsSection>
{/if}

<style>
	.danger-box {
		margin-top: 0.9rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		overflow: hidden;
	}

	.danger-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		padding: 0.9rem var(--space-4);
		background: var(--panel);
	}

	.danger-row.bad {
		background: color-mix(in srgb, var(--error) 5%, var(--panel));
		border-top: 1px solid color-mix(in srgb, var(--error) 25%, transparent);
	}

	.strong {
		font-weight: 500;
	}

	.danger-form {
		padding: var(--space-3) var(--space-4) var(--space-4);
		background: var(--panel);
	}

	.danger-form.bad {
		background: color-mix(in srgb, var(--error) 5%, var(--panel));
	}
</style>
