<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import { dropzone } from '#lib/shared/dropzone.js';
	import { plural } from '#lib/shared/format.js';
	import SnapshotChoice from './SnapshotChoice.svelte';
	import JavaPrompt from './JavaPrompt.svelte';
	import VersionPicker from './VersionPicker.svelte';
	import type { SnapshotPromptView } from '#lib/shared/snapshots.js';

	/**
	 * Move an installed pack to another version (or reinstall the current one),
	 * picked from the provider or uploaded as a file. A pack installed from an
	 * uploaded file has no project to list versions from: it has only the upload.
	 * The preview is fetched separately because resolving a CurseForge version
	 * downloads its overrides archive, which can take a while.
	 */
	let {
		instanceId,
		pack,
		running,
		snapshotPrompt,
		offeredVersionId = null,
		form
	}: {
		instanceId: string;
		pack: { source: string; projectId: string | null; name: string | null; versionId: string | null; versionName: string | null };
		running: boolean;
		snapshotPrompt: SnapshotPromptView;
		/** A version the overview's update notice links to: picked and previewed at once. */
		offeredVersionId?: string | null;
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
		uploaded: boolean;
		otherPack: boolean;
		current: { minecraft: string; loader: string; loaderVersion: string | null };
		target: { name: string; version: string | null; minecraft: string; loader: string; loaderVersion: string | null };
		minecraftChange: boolean;
		loaderChange: boolean;
		mods: { add: string[]; update: string[]; remove: string[]; keep: number; replaced: { from: string; to: string }[] };
		configs: string[];
		world: {
			folder: string;
			packFolder: string;
			datapacks: { add: string[]; update: string[]; remove: string[] };
			previousUnknown: boolean;
			newFiles: string[];
		};
		manual: ManualMod[];
		ownFiles: { known: boolean; back: string[]; packWins: string[]; stays: string[] };
	};

	let versions = $state<PackVersion[]>([]);
	let versionsError = $state('');
	// svelte-ignore state_referenced_locally
	let versionId = $state(offeredVersionId ?? pack.versionId ?? '');
	let plan = $state<Plan | null>(null);
	let planning = $state(false);
	let planError = $state('');
	let confirmMinecraft = $state(false);
	let submitting = $state(false);

	$effect(() => {
		if (!pack.projectId) return;
		const params = new URLSearchParams({ source: pack.source, id: pack.projectId });
		fetch(`/api/packs/versions?${params}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error('lookup failed'))))
			.then((body) => {
				versions = body.versions ?? [];
				if (!versionId) versionId = versions[0]?.id ?? '';
				if (offeredVersionId && offeredVersionId === versionId && versions.some((v) => v.id === offeredVersionId)) void preview();
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

	/** The user's own files ticked to keep (plan.ownFiles); none until ticked, as each preview starts. */
	let keepOwn = $state<string[]>([]);
	$effect(() => {
		void plan;
		keepOwn = [];
	});
	/** `back` by top-level folder, for the count line. */
	const backByFolder = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const rel of plan?.ownFiles.back ?? []) counts.set(rel.split('/')[0], (counts.get(rel.split('/')[0]) ?? 0) + 1);
		return [...counts];
	});
	const looksLikeDatapack = (rel: string) => /\/datapacks\/|\.zip$/i.test(rel);

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

	let uploading = $state(false);
	let uploadInput: HTMLInputElement | null = $state(null);

	/** A pack file instead of a listed version: sent whole, previewed like one. */
	async function previewUpload(file: File) {
		uploading = true;
		planError = '';
		plan = null;
		try {
			const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/pack-change`, { method: 'PUT', body: file });
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Could not read that pack file.');
			plan = (await res.json()).plan;
		} catch (err) {
			planError = err instanceof Error ? err.message : 'Could not read that pack file.';
		} finally {
			uploading = false;
			if (uploadInput) uploadInput.value = '';
		}
	}

	let blockingMods = $derived(plan?.manual.filter((m) => m.blocking) ?? []);
	const datapackChanges = $derived(
		!!plan && plan.world.datapacks.add.length + plan.world.datapacks.update.length + plan.world.datapacks.remove.length > 0
	);
	/** A mod the new version ships as a renamed file is one updated mod, not one removed and one added. */
	const modChanges = $derived.by(() => {
		const replaced = plan?.mods.replaced ?? [];
		const from = new Set(replaced.map((r) => r.from));
		const to = new Set(replaced.map((r) => r.to));
		return {
			added: plan?.mods.add.filter((f) => !to.has(f)) ?? [],
			removed: plan?.mods.remove.filter((f) => !from.has(f)) ?? [],
			updated: (plan?.mods.update.length ?? 0) + replaced.length
		};
	});
	let canApply = $derived(!!plan && !running && !submitting && (!plan.minecraftChange || confirmMinecraft));
</script>

{#snippet ownList(files: string[])}
	<div class="own-actions">
		<button type="button" class="button-quiet" onclick={() => (keepOwn = [...new Set([...keepOwn, ...files])])}>Keep all</button>
		<button type="button" class="button-quiet" onclick={() => (keepOwn = keepOwn.filter((f) => !files.includes(f)))}>Keep none</button>
	</div>
	<ul class="files own">
		{#each files as f (f)}
			<li class="check">
				<input id="keep-{f}" type="checkbox" name="keepOwn" value={f} bind:group={keepOwn} />
				<label for="keep-{f}">{f}{#if looksLikeDatapack(f)}{' '}<span class="tag">data pack</span>{/if}</label>
			</li>
		{/each}
	</ul>
{/snippet}

<section class="panel" use:dropzone={{ input: uploadInput, disabled: uploading || planning, label: 'Drop the new version’s pack file (.mrpack or .zip)' }}>
	<div class="panel-head">
		<div>
			<h2>Modpack version</h2>
			<p>
				{pack.name ?? 'This pack'} is on <strong>{currentLabel}</strong>.
				{#if pack.projectId}
					Pick another version to update or downgrade, or the same one to reinstall the pack's own files; or upload
					a pack file (a build the list does not have).
				{:else}
					It was installed from an uploaded file, so upload the new version's file (<code>.mrpack</code> or CurseForge
					zip) to move to it.
				{/if}
				Folders the pack ships (configs, scripts
				and so on) are moved to <code>old-configs/</code> first, never deleted, and your
				<code>server.properties</code>, world and mods you added yourself are left alone.
			</p>
		</div>
	</div>

	{#if pack.projectId}
	<div class="field">
		<label for="pack-version">Version</label>
		{#if versionsError}
			<p class="hint warn-text">{versionsError}</p>
		{:else}
			<VersionPicker
				id="pack-version"
				bind:value={versionId}
				disabled={!versions.length}
				busy={!versions.length}
				empty="Loading."
				options={versions.map((v) => ({
					value: v.id,
					label: `${v.versionNumber}${v.gameVersions.length ? ` - MC ${v.gameVersions.join(', ')}` : ''}${v.channel !== 'release' ? ` (${v.channel})` : ''}${v.id === pack.versionId ? ' (installed)' : ''}`,
					prerelease: v.channel !== 'release'
				}))}
			/>
		{/if}
	</div>

	<button type="button" onclick={preview} disabled={!versionId || planning || uploading}>
		{planning ? 'Looking up the version' : 'Preview changes'}
	</button>
	{#if planning}
		<p class="hint">CurseForge packs download their configs archive for this, which can take a minute.</p>
	{/if}
	{/if}

	<div class="upload">
		<label class="button" class:button-quiet={!!pack.projectId} aria-disabled={uploading || planning}>
			{uploading ? 'Reading the pack file' : 'Upload a pack file'}
			<input
				bind:this={uploadInput}
				type="file"
				accept=".mrpack,.zip"
				class="visually-hidden"
				disabled={uploading || planning}
				onchange={(e) => {
					const file = e.currentTarget.files?.[0];
					if (file) void previewUpload(file);
				}}
			/>
		</label>
		{#if uploading}
			<p class="hint">A CurseForge zip lists its mods by id, so each one is looked up first; a big pack takes a minute.</p>
		{/if}
	</div>
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

			{#if plan.otherPack}
				<p class="notice warning small">
					This file is <strong>{plan.target.name}</strong>, not {pack.name}. If it is another pack, its mods replace this
					one's; mods you added yourself still stay.
				</p>
			{/if}

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
					{plan.sameVersion ? 'Reinstalls' : 'Moves to'} <strong>{plan.target.name} {plan.target.version ?? ''}</strong>{plan.uploaded
						? ' (uploaded file)'
						: ''}
				</li>
				{#if plan.loaderChange}
					<li>
						Loader: {plan.current.loader} {plan.current.loaderVersion ?? ''} →
						<strong>{plan.target.loader} {plan.target.loaderVersion ?? '(latest)'}</strong>
					</li>
				{/if}
				<li>
					Pack mods: <strong>{modChanges.added.length}</strong> added, <strong>{modChanges.updated}</strong>
					updated, <strong>{modChanges.removed.length}</strong> removed, {plan.mods.keep} unchanged
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

			{#if plan.ownFiles.packWins.length || plan.ownFiles.stays.length || plan.ownFiles.back.length}
				<h3>Your own files in the folders that move</h3>
				{#if plan.ownFiles.back.length}
					<p class="small muted">
						{plural(plan.ownFiles.back.length, 'file')} the installed version did not ship (added by you, or written by a mod)
						{plan.ownFiles.back.length === 1 ? 'comes' : 'come'} back as {plan.ownFiles.back.length === 1 ? 'it is' : 'they are'}:
						{backByFolder.map(([folder, n]) => `${n} in ${folder}/`).join(', ')}.
					</p>
					<details>
						<summary>Files that come back</summary>
						<ul class="files">
							{#each plan.ownFiles.back as f (f)}<li>{f}</li>{/each}
						</ul>
					</details>
				{/if}
				{#if plan.ownFiles.packWins.length}
					<p class="small">
						The new version ships its own file where you have one. The pack's goes in place unless you keep yours (yours
						stays in <code>old-configs/</code> either way, and can be picked later under the merge review):
					</p>
					{@render ownList(plan.ownFiles.packWins)}
				{/if}
				{#if plan.ownFiles.stays.length}
					<p class="notice warning small">
						MineShell has no record of the files the installed version shipped, so it cannot tell yours from the pack's,
						and nothing is merged. {plan.ownFiles.stays.length === 1 ? 'This file is' : `These ${plan.ownFiles.stays.length} files are`} not in the new version and {plan.ownFiles.stays.length === 1 ? 'stays' : 'stay'} only in
						<code>old-configs/</code> unless ticked; tick the ones you added.
					</p>
					{@render ownList(plan.ownFiles.stays)}
				{/if}
			{/if}

			{#if plan.mods.add.length || plan.mods.update.length || plan.mods.remove.length}
				<details>
					<summary>Pack mod changes</summary>
					<ul class="files">
						{#each modChanges.added as f (f)}<li class="added">+ {f}</li>{/each}
						{#each plan.mods.update as f (f)}<li>~ {f}</li>{/each}
						{#each plan.mods.replaced as r (r.to)}<li>~ {r.from} → {r.to}</li>{/each}
						{#each modChanges.removed as f (f)}<li class="removed">− {f}</li>{/each}
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

	.upload {
		margin-top: var(--space-3);
	}

	.upload label[aria-disabled='true'] {
		opacity: 0.6;
		pointer-events: none;
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

	/* Each line carries its own +, ~ or − mark, so no bullet before it. */
	.files {
		max-height: 16rem;
		overflow-y: auto;
		font-family: var(--font-mono);
		font-size: 0.8rem;
		list-style: none;
	}

	.added {
		color: var(--success, inherit);
	}

	.files.own {
		list-style: none;
		padding-left: 0;
	}

	.own-actions {
		display: flex;
		gap: var(--space-2);
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
