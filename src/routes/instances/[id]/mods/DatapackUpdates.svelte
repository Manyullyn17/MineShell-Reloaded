<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import SnapshotChoice from '#lib/components/SnapshotChoice.svelte';
	import type { PageData } from './$types';

	/**
	 * Updates for the data packs installed from the mod browser, in the Data
	 * packs sub-tab: check, pick, update. A world-generation pack the world has
	 * loaded is updated only with the server stopped, after a snapshot.
	 */
	let {
		instanceId,
		running,
		busy,
		snapshotPrompt
	}: {
		instanceId: string;
		running: boolean;
		busy: boolean;
		snapshotPrompt: PageData['snapshotPrompt'];
	} = $props();

	type Check = {
		updates: { fileName: string; name: string; currentVersion: string | null; targetVersionId: string; targetVersion: string; channel: string; worldgenInUse: boolean }[];
		upToDate: number;
		skipped: { fileName: string; name: string; reason: string }[];
	};
	let check = $state<Check | null>(null);
	let checking = $state(false);
	let checkError = $state('');
	let chosen = $state<Record<string, boolean>>({});
	const chosenCount = $derived(Object.values(chosen).filter(Boolean).length);
	const riskyChosen = $derived(check?.updates.filter((u) => u.worldgenInUse && chosen[u.fileName]) ?? []);

	async function run() {
		checking = true;
		checkError = '';
		try {
			const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/datapack-updates`);
			const body = await res.json();
			if (!res.ok) throw new Error(body.message ?? 'Checking for updates failed.');
			check = body;
			// A world-generation pack the world has loaded starts unticked: updating it can break the world.
			chosen = Object.fromEntries(body.updates.map((u: { fileName: string; worldgenInUse: boolean }) => [u.fileName, !u.worldgenInUse]));
		} catch (err) {
			checkError = err instanceof Error ? err.message : 'Checking for updates failed.';
		} finally {
			checking = false;
		}
	}
</script>

{#if checkError}
	<p class="notice warning">{checkError}</p>
{/if}
{#if !check}
	<button type="button" onclick={run} disabled={checking || busy}>{checking ? 'Checking for updates' : 'Check for updates'}</button>
{:else if check.updates.length === 0}
	<p class="small muted">
		The data packs installed from Add mods are up to date ({check.upToDate}).
		<button type="button" class="button-quiet" onclick={run} disabled={checking}>{checking ? 'Checking' : 'Check again'}</button>
	</p>
{:else}
	<form
		method="POST"
		action="?/updateDatapacks"
		class="datapack-updates"
		use:enhance={() => async ({ result, update }) => {
			await update({ reset: false });
			if (result.type === 'success') check = null;
		}}
	>
		<div class="section-head">
			<div>
				<h3>{check.updates.length} data pack update{check.updates.length === 1 ? '' : 's'}</h3>
			</div>
			<div class="button-row">
				<button type="button" onclick={run} disabled={checking}>{checking ? 'Checking' : 'Check again'}</button>
				<button class="button-primary" type="submit" disabled={!chosenCount || (riskyChosen.length > 0 && running)}>
					Update {chosenCount} data pack{chosenCount === 1 ? '' : 's'}
				</button>
			</div>
		</div>
		<ul class="update-list">
			{#each check.updates as u (u.fileName)}
				<li>
					<label class="update">
						<input type="checkbox" name="change" value={`${u.fileName}\n${u.targetVersionId}`} bind:checked={chosen[u.fileName]} />
						<span class="update-name">
							<span>
								{u.name}
								{#if u.channel !== 'release'}<span class="tag warn">{u.channel}</span>{/if}
								{#if u.worldgenInUse}<span class="tag warn">world generation, in use</span>{/if}
							</span>
							{#if u.worldgenInUse}
								<span class="faint small">This world has loaded it: a version that renames or drops a biome can keep the world from loading.</span>
							{/if}
						</span>
						<span class="mono small versions">{u.currentVersion ?? '?'} → <span class="to">{u.targetVersion}</span></span>
					</label>
				</li>
			{/each}
		</ul>
		{#if riskyChosen.length}
			{#if running}
				<p class="notice warning small">Stop the server to update {riskyChosen.map((u) => u.name).join(', ')}.</p>
			{/if}
			<SnapshotChoice prompt={snapshotPrompt} idPrefix="update-datapacks" />
		{/if}
	</form>
{/if}
{#if check?.skipped.length}
	<details class="skipped">
		<summary class="small">{check.skipped.length} not checked</summary>
		<ul class="small">
			{#each check.skipped as s (s.fileName)}
				<li>{s.name} <span class="muted">- {s.reason}</span></li>
			{/each}
		</ul>
	</details>
{/if}

<style>
	.datapack-updates {
		margin-bottom: var(--space-4);
	}

	h3 {
		margin: 0;
		font-size: 1rem;
	}

	.update-list {
		list-style: none;
		margin: 0 0 var(--space-3);
		padding: 0;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		overflow: hidden;
	}

	.update-list li + li {
		border-top: 1px solid var(--line);
	}

	.update {
		display: flex;
		align-items: center;
		gap: 0.9rem;
		margin: 0;
		padding: 0.75rem var(--space-4);
		color: var(--text);
		font-size: 0.93rem;
		cursor: pointer;
	}

	.update-name {
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	.versions {
		color: var(--text-muted);
	}

	.versions .to {
		color: var(--accent-hover);
	}

	.skipped {
		margin: var(--space-3) 0;
	}
</style>
