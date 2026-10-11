<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import { formatBytes, formatDateTime } from '#lib/shared/format.js';
	import type { SnapshotPromptView } from '#lib/shared/snapshots.js';
	import SnapshotChoice from './SnapshotChoice.svelte';
	import JavaPrompt from './JavaPrompt.svelte';

	/**
	 * Undo the last pack version change (packrollback.ts): the version before,
	 * its configs exactly as they were, and optionally the world from the
	 * snapshot taken before the change. The user's own mods stay and are named.
	 */
	let {
		info,
		running,
		snapshotPrompt,
		form
	}: {
		info: {
			changedAt: number;
			from: { versionName: string | null; minecraft: string };
			to: { versionName: string | null };
			blocked: string | null;
			snapshot: { id: string; createdAt: number; sizeBytes: number; note: string | null } | null;
			needsWorld: boolean;
			keptMods: { updatedByChange: string[]; changedSince: string[] };
			missingConfigs: string[];
		};
		running: boolean;
		snapshotPrompt: SnapshotPromptView;
		form: { javaMissing?: { major: number; action: string }; [key: string]: unknown } | null | undefined;
	} = $props();

	const name = (v: string | null) => (v ?? 'the version before').replace(/\.(zip|mrpack)$/i, '');
	let open = $state(false);
	let submitting = $state(false);
	// svelte-ignore state_referenced_locally
	let world = $state<'keep' | 'restore'>(info.needsWorld ? 'restore' : 'keep');
	$effect(() => {
		if (info.needsWorld) world = 'restore';
	});
	const kept = $derived([...info.keptMods.updatedByChange, ...info.keptMods.changedSince]);
</script>

<section class="panel rollback">
	<div class="head">
		<div>
			<h3>Last change</h3>
			<p class="small muted">
				{name(info.from.versionName)} → {name(info.to.versionName)}, {formatDateTime(info.changedAt)}
			</p>
		</div>
		{#if !info.blocked}
			<button type="button" class="button-quiet" aria-expanded={open} onclick={() => (open = !open)}>
				Roll back to {name(info.from.versionName)}
			</button>
		{/if}
	</div>

	{#if info.blocked}
		<p class="hint">{info.blocked}</p>
	{:else if open}
		<form
			method="POST"
			action="?/rollbackPack"
			use:enhance={() => {
				submitting = true;
				return async ({ result, update }) => {
					await update({ reset: false });
					submitting = false;
					if (result.type === 'success') open = false;
				};
			}}
		>
			<p class="small">
				Installs {name(info.from.versionName)} again with its mods, and puts the configs and other pack folders back
				exactly as they were before the change (not merged). What they are now is kept in <code>old-configs/</code>.
			</p>

			{#if kept.length}
				<div class="notice info small">
					<p>Your own mods are not rolled back; they stay as they are:</p>
					<ul>
						{#if info.keptMods.updatedByChange.length}
							<li>updated by the change: {info.keptMods.updatedByChange.join(', ')}</li>
						{/if}
						{#if info.keptMods.changedSince.length}
							<li>added or changed since: {info.keptMods.changedSince.join(', ')}</li>
						{/if}
					</ul>
					<p>Change them on the Mods tab if they need the older version.</p>
				</div>
			{/if}
			{#if info.missingConfigs.length}
				<p class="notice warning small">
					The copies of {info.missingConfigs.join(', ')} from before the change are no longer in <code>old-configs/</code>;
					those get {name(info.from.versionName)}'s own files instead.
				</p>
			{/if}

			<fieldset class="world">
				<legend>The world</legend>
				{#if info.snapshot}
					<div class="check">
						<input id="rollback-keep" type="radio" name="world" value="keep" bind:group={world} disabled={info.needsWorld} />
						<label for="rollback-keep">Keep it as it is</label>
					</div>
					<div class="check">
						<input id="rollback-world" type="radio" name="world" value="restore" bind:group={world} />
						<label for="rollback-world">
							Put it back as it was before the change, from the snapshot of {formatDateTime(info.snapshot.createdAt)}
							({formatBytes(info.snapshot.sizeBytes)})
						</label>
					</div>
					{#if info.needsWorld}
						<p class="hint">
							The change moved Minecraft from {info.from.minecraft}; a world that ran on the newer version does not load in the
							older one, so it comes back too.
						</p>
					{/if}
					{#if world === 'restore'}
						<p class="hint warn-text">
							Everything played since that snapshot is undone. The world as it is now is kept as a snapshot (World tab).
						</p>
					{/if}
				{:else}
					<p class="small muted">
						Stays as it is: there is no snapshot from before the change (none was taken, or it has been deleted since).
					</p>
				{/if}
			</fieldset>

			{#if world === 'keep'}
				<SnapshotChoice prompt={snapshotPrompt} idPrefix="rollback" />
			{/if}
			<JavaPrompt {form} action="rollbackPack" />
			{#if running}
				<p class="hint">Stop the server to roll back.</p>
			{/if}
			<div class="button-row">
				<button class="button-primary" type="submit" disabled={running || submitting}>
					{submitting ? 'Starting' : `Roll back to ${name(info.from.versionName)}`}
				</button>
				<button class="button-quiet" type="button" onclick={() => (open = false)}>Cancel</button>
			</div>
		</form>
	{/if}
</section>

<style>

	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	h3 {
		margin: 0;
	}

	form {
		margin-top: var(--space-3);
		display: grid;
		gap: var(--space-3);
	}

	.world {
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
		margin: 0;
	}

	.notice ul {
		margin: var(--space-1) 0;
		padding-left: 1.2rem;
	}
</style>
