<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import SnapshotChoice from '#lib/components/SnapshotChoice.svelte';
	import DependencyList, { type DependencyPlan } from './DependencyList.svelte';
	import type { PageData } from './$types';

	/**
	 * The Updates sub-tab: check every tracked mod, pick, update. Stays mounted
	 * while another sub-tab is open (`active` false), so a check is not lost.
	 */
	let {
		active,
		instanceId,
		packName,
		running,
		busy,
		snapshotPrompt,
		packMods = $bindable(),
		available = $bindable(0),
		checkOnOpen = false
	}: {
		active: boolean;
		instanceId: string;
		packName: string | null;
		running: boolean;
		busy: boolean;
		snapshotPrompt: PageData['snapshotPrompt'];
		/** A pack's single mods may be changed (the page's switch, shared with Installed). */
		packMods: boolean;
		/** How many updates the last check found, for the tab's badge. */
		available?: number;
		/** Run the check at once (arriving from the overview's notice). */
		checkOnOpen?: boolean;
	} = $props();

	const changesLocked = $derived(!!packName && !packMods);

	type UpdateCheck = {
		updates: { fileName: string; name: string; currentVersion: string | null; targetVersionId: string; targetVersion: string; channel: string; enabled: boolean; fromPack: boolean; disabledReason: string | null; note: string | null }[];
		upToDate: number;
		skipped: { fileName: string; name: string; reason: string }[];
		dependencies: DependencyPlan;
		synced: string | null;
	};
	let updateCheck = $state<UpdateCheck | null>(null);
	let checking = $state(false);
	let progress = $state<{ phase: 'sync' | 'check' | 'dependencies'; done: number; total: number } | null>(null);
	const progressText = $derived(
		progress?.phase === 'sync'
			? 'Identifying jars MineShell has no record of'
			: progress?.phase === 'dependencies'
				? 'Working out what the updates need'
				: progress?.total
					? `Checked ${progress.done} of ${progress.total} mods`
					: 'Checking for updates'
	);
	let checkError = $state('');
	let chosenUpdates = $state<Record<string, boolean>>({});
	const chosenCount = $derived(Object.values(chosenUpdates).filter(Boolean).length);
	$effect(() => {
		available = updateCheck?.updates.length ?? 0;
	});

	let checkedOnOpen = false;
	$effect(() => {
		if (!checkOnOpen || !active || checkedOnOpen) return;
		checkedOnOpen = true;
		void checkUpdates();
	});

	/** The check answers a line per step (`progress`), then `result`; the last list stays up meanwhile. */
	async function checkUpdates() {
		checking = true;
		checkError = '';
		progress = null;
		try {
			const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/mod-updates`);
			if (!res.ok || !res.body) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message ?? 'Checking for updates failed.');
			}
			const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
			let buffer = '';
			let result: UpdateCheck | null = null;
			for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
				const lines = (buffer + chunk.value).split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines.filter((l) => l.trim())) {
					const message = JSON.parse(line);
					if (message.progress) progress = message.progress;
					else if (message.result) result = message.result;
					else throw new Error(message.message ?? 'Checking for updates failed.');
				}
			}
			if (!result) throw new Error('Checking for updates failed.');
			updateCheck = result;
			// A disabled mod is updated only when ticked: it is off for a reason.
			chosenUpdates = Object.fromEntries(result.updates.map((u) => [u.fileName, u.enabled]));
		} catch (err) {
			checkError = err instanceof Error ? err.message : 'Checking for updates failed.';
		} finally {
			checking = false;
			progress = null;
		}
	}
</script>

{#snippet checkProgress()}
	{#if checking}
		<div class="check-progress" role="status">
			<p class="small muted">{progressText}</p>
			<div class="progress" aria-hidden="true">
				{#if progress?.phase === 'check' && progress.total}
					<span style="width: {(progress.done / progress.total) * 100}%"></span>
				{:else}
					<span class="indeterminate"></span>
				{/if}
			</div>
		</div>
	{/if}
{/snippet}

{#if active}
	{#if checkError}
		<p class="notice warning">{checkError}</p>
	{/if}

	{#if !updateCheck}
		<div class="section-head">
			<div>
				<h2>Updates</h2>
				<p>Checks every Modrinth and CurseForge mod for a newer build for this Minecraft version and loader.</p>
			</div>
			<div class="button-row">
				{#if packName}
					<span class="pack-toggle">
						<input id="pack-mods-u" type="checkbox" class="switch" role="switch" bind:checked={packMods} disabled={running} />
						<label for="pack-mods-u">Allow changing single mods</label>
						{#if running}<span class="faint">· stop the server first</span>{/if}
					</span>
				{/if}
				<button
					class="button-primary"
					type="button"
					onclick={checkUpdates}
					disabled={changesLocked || checking || running || busy}
					title={running ? 'Stop the server to update its mods' : changesLocked ? 'Allow changing single mods first' : undefined}
				>
					{checking ? 'Checking for updates' : 'Check for updates'}
				</button>
			</div>
		</div>
		{@render checkProgress()}
		{#if running}
			<p class="faint small">Stop the server to update its mods.</p>
		{/if}
	{:else}
		{#if updateCheck.synced}
			<p class="hint">Untracked jars were synced first: {updateCheck.synced}.</p>
		{/if}
		{#if updateCheck.updates.length === 0}
			<div class="section-head">
				<div>
					<h2>Up to date</h2>
					<p>Everything that can be checked is up to date ({updateCheck.upToDate} mod{updateCheck.upToDate === 1 ? '' : 's'}).</p>
				</div>
				<button type="button" onclick={checkUpdates} disabled={checking}>{checking ? 'Checking' : 'Check again'}</button>
			</div>
			{@render checkProgress()}
		{:else}
			<form
				method="POST"
				action="?/updateMods"
				use:enhance={() => async ({ result, update }) => {
					await update({ reset: false });
					if (result.type === 'success') updateCheck = null;
				}}
			>
				{#if packMods}<input type="hidden" name="packMods" value="on" />{/if}
				<div class="section-head">
					<div>
						<h2>{updateCheck.updates.length} update{updateCheck.updates.length === 1 ? '' : 's'} available</h2>
						<p>Checked against Modrinth and CurseForge.</p>
					</div>
					<div class="button-row">
						<button type="button" onclick={checkUpdates} disabled={checking}>{checking ? 'Checking' : 'Check again'}</button>
						<button class="button-primary" type="submit" disabled={!chosenCount || running || checking}>
							Update {chosenCount} mod{chosenCount === 1 ? '' : 's'}
						</button>
					</div>
				</div>
				{@render checkProgress()}
				<ul class="update-list">
					{#each updateCheck.updates as u (u.fileName)}
						<li>
							<label class="update">
								<input
									type="checkbox"
									name="change"
									value={`${u.fileName}\n${u.targetVersionId}`}
									bind:checked={chosenUpdates[u.fileName]}
								/>
								<span class="update-name">
									<span>
										{u.name}
										{#if u.channel !== 'release'}<span class="tag warn">{u.channel}</span>{/if}
									</span>
									{#if u.note}<span class="muted small">{u.note}</span>{/if}
									{#if !u.enabled}
										<span class="faint small">
											{u.disabledReason ? `Disabled, ${u.disabledReason}.` : 'Disabled.'} Not updated unless ticked, and stays disabled.
										</span>
									{/if}
								</span>
								<span class="mono small versions">
									{u.currentVersion ?? '?'} → <span class="to">{u.targetVersion}</span>
								</span>
							</label>
						</li>
					{/each}
				</ul>
				<DependencyList plan={updateCheck.dependencies} />
				<SnapshotChoice prompt={snapshotPrompt} idPrefix="update-mods" />
			</form>
		{/if}
		{#if updateCheck.skipped.length}
			<details class="skipped">
				<summary class="small">{updateCheck.skipped.length} not checked</summary>
				<ul class="small">
					{#each updateCheck.skipped as s (s.fileName)}
						<li>{s.name} <span class="muted">- {s.reason}</span></li>
					{/each}
				</ul>
			</details>
		{/if}
	{/if}
{/if}

<style>
	.pack-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.pack-toggle label {
		cursor: pointer;
		margin: 0;
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
		margin-top: var(--space-3);
	}

	.check-progress {
		margin-bottom: var(--space-3);
	}

	.check-progress p {
		margin-bottom: var(--space-1);
	}
</style>
