<script lang="ts">
	import { enhance } from '$app/forms';
	import SnapshotChoice from './SnapshotChoice.svelte';
	import JavaPrompt from './JavaPrompt.svelte';
	import type { SnapshotPromptView } from '$lib/shared/snapshots';

	/**
	 * Move an installed pack to another version (or reinstall the current one).
	 * The preview is fetched separately because resolving a CurseForge version
	 * downloads its overrides archive, which can take a while.
	 */
	let {
		instanceId,
		pack,
		running,
		snapshotPrompt,
		form
	}: {
		instanceId: string;
		pack: { source: string; projectId: string; name: string | null; versionId: string | null; versionName: string | null };
		running: boolean;
		snapshotPrompt: SnapshotPromptView;
		/** The page's action result, for the missing-Java prompt. */
		form: { javaMissing?: { major: number; action: string }; [key: string]: unknown } | null | undefined;
	} = $props();

	type PackVersion = { id: string; versionNumber: string; gameVersions: string[]; channel: string };
	type ManualMod = {
		fileName: string;
		name: string;
		source: string;
		currentVersion: string | null;
		status: 'update' | 'current' | 'unavailable' | 'unknown';
		targetVersion: string | null;
		blocking: boolean;
		message: string | null;
	};
	type Plan = {
		versionId: string;
		sameVersion: boolean;
		current: { minecraft: string; loader: string; loaderVersion: string | null };
		target: { name: string; version: string | null; minecraft: string; loader: string; loaderVersion: string | null };
		minecraftChange: boolean;
		loaderChange: boolean;
		mods: { add: string[]; update: string[]; remove: string[]; keep: number };
		configs: string[];
		world: {
			folder: string;
			packFolder: string;
			datapacks: { add: string[]; update: string[]; remove: string[] };
			previousUnknown: boolean;
			newFiles: string[];
		};
		manual: ManualMod[];
	};

	let versions = $state<PackVersion[]>([]);
	let versionsError = $state('');
	// svelte-ignore state_referenced_locally
	let versionId = $state(pack.versionId ?? '');
	let plan = $state<Plan | null>(null);
	let planning = $state(false);
	let planError = $state('');
	let confirmMinecraft = $state(false);
	let submitting = $state(false);

	$effect(() => {
		const params = new URLSearchParams({ source: pack.source, id: pack.projectId });
		fetch(`/api/packs/versions?${params}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error('lookup failed'))))
			.then((body) => {
				versions = body.versions ?? [];
				if (!versionId) versionId = versions[0]?.id ?? '';
			})
			.catch(() => (versionsError = "Could not load the pack's versions."));
	});

	// A different pick invalidates the preview.
	$effect(() => {
		void versionId;
		plan = null;
		planError = '';
		confirmMinecraft = false;
	});

	let currentLabel = $derived(
		versions.find((v) => v.id === pack.versionId)?.versionNumber ?? pack.versionName ?? pack.versionId ?? 'unknown'
	);

	async function preview() {
		planning = true;
		planError = '';
		plan = null;
		try {
			const res = await fetch(
				`/api/instances/${encodeURIComponent(instanceId)}/pack-change?versionId=${encodeURIComponent(versionId)}`
			);
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Preview failed.');
			plan = (await res.json()).plan;
		} catch (err) {
			planError = err instanceof Error ? err.message : 'Preview failed.';
		} finally {
			planning = false;
		}
	}

	let blockingMods = $derived(plan?.manual.filter((m) => m.blocking) ?? []);
	const datapackChanges = $derived(
		!!plan && plan.world.datapacks.add.length + plan.world.datapacks.update.length + plan.world.datapacks.remove.length > 0
	);
	let canApply = $derived(!!plan && !running && !submitting && (!plan.minecraftChange || confirmMinecraft));
</script>

<section class="panel">
	<div class="panel-head">
		<div>
			<h2>Modpack version</h2>
			<p>
				{pack.name ?? 'This pack'} is on <strong>{currentLabel}</strong>. Pick another version to update or
				downgrade, or the same one to reinstall the pack's own files. Folders the pack ships (configs, scripts
				and so on) are moved to <code>old-configs/</code> first, never deleted, and your
				<code>server.properties</code>, world and mods you added yourself are left alone.
			</p>
		</div>
	</div>

	<div class="field">
		<label for="pack-version">Version</label>
		{#if versionsError}
			<p class="hint warn-text">{versionsError}</p>
		{:else}
			<select id="pack-version" bind:value={versionId} disabled={!versions.length}>
				{#if !versions.length}<option value="">Loading.</option>{/if}
				{#each versions as v (v.id)}
					<option value={v.id}>
						{v.versionNumber}{v.gameVersions.length ? ` - MC ${v.gameVersions.join(', ')}` : ''}{v.channel !== 'release' ? ` (${v.channel})` : ''}{v.id === pack.versionId ? ' (installed)' : ''}
					</option>
				{/each}
			</select>
		{/if}
	</div>

	<button type="button" onclick={preview} disabled={!versionId || planning}>
		{planning ? 'Looking up the version' : 'Preview changes'}
	</button>
	{#if planning}
		<p class="hint">CurseForge packs download their configs archive for this, which can take a minute.</p>
	{/if}
	{#if planError}
		<p class="hint warn-text">{planError}</p>
	{/if}

	{#if plan}
		<form
			method="POST"
			action="?/changePack"
			class="plan"
			use:enhance={() => {
				submitting = true;
				return async ({ result, update }) => {
					await update({ reset: false });
					submitting = false;
					// Kept on a refusal, so its answer (a Java download, a snapshot choice) can be given here.
					if (result.type === 'success') plan = null;
				};
			}}
		>
			<input type="hidden" name="versionId" value={plan.versionId} />

			{#if plan.minecraftChange}
				<div class="danger">
					<strong>Minecraft {plan.current.minecraft} → {plan.target.minecraft}</strong>
					<p>
						Changing the Minecraft version can corrupt or permanently break an existing world: chunks,
						items and blocks from removed or changed mods can be lost, and there is no undo once the
						server has loaded the world. Keep the snapshot below, or back up the world folder first.
					</p>
					<div class="check">
						<input id="confirm-mc" name="confirmMinecraft" type="checkbox" bind:checked={confirmMinecraft} />
						<label for="confirm-mc">I understand the world may be damaged</label>
					</div>
				</div>
			{/if}

			<ul class="summary">
				<li>
					{plan.sameVersion ? 'Reinstalls' : 'Moves to'} <strong>{plan.target.name} {plan.target.version ?? ''}</strong>
				</li>
				{#if plan.loaderChange}
					<li>
						Loader: {plan.current.loader} {plan.current.loaderVersion ?? ''} →
						<strong>{plan.target.loader} {plan.target.loaderVersion ?? '(latest)'}</strong>
					</li>
				{/if}
				<li>
					Pack mods: <strong>{plan.mods.add.length}</strong> added, <strong>{plan.mods.update.length}</strong>
					updated, <strong>{plan.mods.remove.length}</strong> removed, {plan.mods.keep} unchanged
				</li>
				{#if plan.configs.length}
					<li>
						Moved to <code>old-configs/</code> and replaced: <code>{plan.configs.join(', ')}</code>
					</li>
				{/if}
				{#if datapackChanges}
					<li>
						Data packs in <code>{plan.world.folder}/datapacks</code>: <strong>{plan.world.datapacks.add.length}</strong>
						added, <strong>{plan.world.datapacks.update.length}</strong> updated,
						<strong>{plan.world.datapacks.remove.length}</strong> moved to <code>old-configs/</code>. Data packs you
						added yourself stay.
					</li>
				{/if}
				{#if plan.world.newFiles.length}
					<li>
						New in the world folder (nothing existing is overwritten): <code>{plan.world.newFiles.join(', ')}</code>
					</li>
				{/if}
			</ul>

			{#if plan.world.previousUnknown && plan.world.datapacks.add.length + plan.world.datapacks.update.length}
				<p class="notice warning small">
					MineShell cannot tell which data packs the installed version put in <code>{plan.world.folder}/datapacks</code>,
					so none are removed. If the new version renamed one, the old copy stays active next to it; check that folder
					afterwards.
				</p>
			{/if}

			{#if datapackChanges}
				<details>
					<summary>Data pack changes</summary>
					<ul class="files">
						{#each plan.world.datapacks.add as f (f)}<li class="added">+ {f}</li>{/each}
						{#each plan.world.datapacks.update as f (f)}<li>~ {f}</li>{/each}
						{#each plan.world.datapacks.remove as f (f)}<li class="removed">− {f}</li>{/each}
					</ul>
				</details>
			{/if}

			{#if plan.mods.add.length || plan.mods.update.length || plan.mods.remove.length}
				<details>
					<summary>Pack mod changes</summary>
					<ul class="files">
						{#each plan.mods.add as f (f)}<li class="added">+ {f}</li>{/each}
						{#each plan.mods.update as f (f)}<li>~ {f}</li>{/each}
						{#each plan.mods.remove as f (f)}<li class="removed">− {f}</li>{/each}
					</ul>
				</details>
			{/if}

			{#if plan.manual.length}
				<h3>Mods you added</h3>
				{#if blockingMods.length}
					<p class="warn-text small">
						{blockingMods.length} of them have no compatible version and will probably stop the server from starting.
					</p>
				{/if}
				<ul class="manual">
					{#each plan.manual as m (m.fileName)}
						<li class:error={m.blocking}>
							{#if m.status === 'update'}
								<div class="check">
									<input id="upd-{m.fileName}" type="checkbox" name="updateMod" value={m.fileName} checked />
									<label for="upd-{m.fileName}">
										<strong>{m.name}</strong> {m.currentVersion ?? '?'} → {m.targetVersion}
									</label>
								</div>
							{:else}
								<strong>{m.name}</strong>
								<span class="muted small">
									{m.status === 'current' ? `up to date (${m.currentVersion})` : (m.message ?? '')}
								</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			<SnapshotChoice prompt={snapshotPrompt} idPrefix="pack" />
			<JavaPrompt {form} action="changePack" />
			{#if running}
				<p class="hint">Stop the server to change the pack version.</p>
			{/if}
			<button class="button-primary" type="submit" disabled={!canApply}>
				{submitting ? 'Starting' : plan.sameVersion ? 'Reinstall pack files' : 'Change pack version'}
			</button>
		</form>
	{/if}
</section>

<style>
	.plan {
		margin-top: var(--space-3);
	}

	.danger {
		border: 1px solid var(--error);
		border-left-width: 4px;
		border-radius: var(--radius, 6px);
		padding: var(--space-3);
		margin-bottom: var(--space-3);
		background: color-mix(in srgb, var(--error) 10%, transparent);
	}

	.danger strong {
		color: var(--error);
		font-size: 1.05rem;
	}

	.summary,
	.files,
	.manual {
		padding-left: 1.2rem;
		font-size: 0.88rem;
		margin: var(--space-2) 0;
	}

	.files {
		max-height: 16rem;
		overflow-y: auto;
		font-family: var(--font-mono);
		font-size: 0.8rem;
	}

	.added {
		color: var(--success, inherit);
	}

	.removed,
	.error,
	.warn-text {
		color: var(--error);
	}

	h3 {
		font-size: 0.95rem;
		margin: var(--space-3) 0 var(--space-1);
	}
</style>
