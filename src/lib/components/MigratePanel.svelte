<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import SnapshotChoice from './SnapshotChoice.svelte';
	import JavaPrompt from './JavaPrompt.svelte';
	import type { SnapshotPromptView } from '#lib/shared/snapshots.js';

	/**
	 * Move the server to another Minecraft version and/or loader (migrate.ts).
	 * The preview is fetched separately: every mod is looked up on its
	 * platform, which takes a moment.
	 */
	let {
		instanceId,
		current,
		minecraftVersions,
		loaders,
		running,
		snapshotPrompt,
		form
	}: {
		instanceId: string;
		current: { minecraft: string; loader: string; loaderVersion: string | null };
		/** Mojang's releases, newest first; undefined while they load. */
		minecraftVersions: string[] | undefined;
		loaders: { id: string; label: string }[];
		running: boolean;
		snapshotPrompt: SnapshotPromptView;
		/** The page's action result, for the missing-Java prompt. */
		form: { javaMissing?: { major: number; action: string }; [key: string]: unknown } | null | undefined;
	} = $props();

	type ModPlan = {
		fileName: string;
		name: string;
		from: string | null;
		action: 'update' | 'keep' | 'disable';
		to: string | null;
		reason: string | null;
		disabled: boolean;
	};
	type Plan = {
		current: { minecraft: string; loader: string; loaderVersion: string | null };
		target: { minecraft: string; loader: string; loaderVersion: string | null };
		minecraftChange: boolean;
		mods: ModPlan[];
		dependencies: {
			install: { name: string; versionNumber: string; neededBy: string[] }[];
			unresolved: { name: string; neededBy: string[]; reason: string }[];
		};
		requiredJava: number;
	};

	// svelte-ignore state_referenced_locally
	let minecraft = $state(current.minecraft);
	// svelte-ignore state_referenced_locally
	let loader = $state(current.loader === 'cleanroom' ? 'forge' : current.loader);
	let loaderVersion = $state('');
	let loaderVersions = $state<string[] | null>(null);
	let plan = $state<Plan | null>(null);
	let planning = $state(false);
	let planError = $state('');
	let confirmMinecraft = $state(false);
	let submitting = $state(false);

	/** Only up: a world opened by a newer Minecraft does not load in an older one. */
	const choices = $derived.by(() => {
		if (!minecraftVersions) return [current.minecraft];
		const at = minecraftVersions.indexOf(current.minecraft);
		return at === -1 ? [current.minecraft, ...minecraftVersions] : minecraftVersions.slice(0, at + 1);
	});
	const labelOf = (id: string) => loaders.find((l) => l.id === id)?.label ?? id;

	// The loader's builds for the picked Minecraft version.
	$effect(() => {
		const [l, mc] = [loader, minecraft];
		loaderVersions = null;
		loaderVersion = '';
		if (l === 'vanilla') {
			loaderVersions = [];
			return;
		}
		let live = true;
		fetch(`/api/loaders/versions?${new URLSearchParams({ loader: l, mc })}`)
			.then((r) => (r.ok ? r.json() : { versions: [] }))
			.then((body) => {
				if (live) loaderVersions = body.versions ?? [];
			})
			.catch(() => live && (loaderVersions = []));
		return () => {
			live = false;
		};
	});

	// A different pick invalidates the preview.
	$effect(() => {
		void [minecraft, loader, loaderVersion];
		plan = null;
		planError = '';
		confirmMinecraft = false;
	});

	const unchanged = $derived(
		minecraft === current.minecraft && loader === current.loader && (!loaderVersion || loaderVersion === current.loaderVersion)
	);

	async function preview() {
		planning = true;
		planError = '';
		plan = null;
		try {
			const params = new URLSearchParams({ mc: minecraft, loader, loaderVersion });
			const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/migrate?${params}`);
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Preview failed.');
			plan = (await res.json()).plan;
		} catch (err) {
			planError = err instanceof Error ? err.message : 'Preview failed.';
		} finally {
			planning = false;
		}
	}

	const of = (action: ModPlan['action']) => plan?.mods.filter((m) => m.action === action) ?? [];
	const canApply = $derived(!!plan && !running && !submitting && (!plan.minecraftChange || confirmMinecraft));
</script>

<div class="pickers">
	<div class="field">
		<label for="migrate-mc">Minecraft</label>
		<select id="migrate-mc" bind:value={minecraft} aria-busy={!minecraftVersions}>
			{#each choices as version (version)}
				<option value={version}>{version}{version === current.minecraft ? ' (installed)' : ''}</option>
			{/each}
		</select>
	</div>
	<div class="field">
		<label for="migrate-loader">Loader</label>
		<select id="migrate-loader" bind:value={loader}>
			{#each loaders.filter((l) => l.id !== 'cleanroom') as l (l.id)}
				<option value={l.id}>{l.label}{l.id === current.loader ? ' (installed)' : ''}</option>
			{/each}
		</select>
	</div>
	{#if loader !== 'vanilla'}
		<div class="field">
			<label for="migrate-loader-version">{labelOf(loader)} version</label>
			<select id="migrate-loader-version" bind:value={loaderVersion} disabled={!loaderVersions?.length} aria-busy={!loaderVersions}>
				{#if !loaderVersions}
					<option value="">Loading</option>
				{:else if !loaderVersions.length}
					<option value="">None for {minecraft}</option>
				{:else}
					<option value="">Newest ({loaderVersions[0]})</option>
					{#each loaderVersions.slice(0, 60) as v (v)}<option value={v}>{v}</option>{/each}
				{/if}
			</select>
		</div>
	{/if}
</div>

<button type="button" onclick={preview} disabled={unchanged || planning || (loader !== 'vanilla' && !loaderVersions?.length)}>
	{planning ? 'Looking up every mod' : 'Preview changes'}
</button>
{#if planError}
	<p class="hint warn-text">{planError}</p>
{/if}

{#if plan}
	<form
		method="POST"
		action="?/migrate"
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
		<input type="hidden" name="minecraft" value={plan.target.minecraft} />
		<input type="hidden" name="loader" value={plan.target.loader} />
		<input type="hidden" name="loaderVersion" value={plan.target.loaderVersion ?? ''} />

		{#if plan.minecraftChange}
			<div class="danger">
				<strong>Minecraft {plan.current.minecraft} → {plan.target.minecraft}</strong>
				<p>
					The world is upgraded the first time the new version opens it, and there is no way back: an older Minecraft
					does not load it again. Blocks and items of mods that are disabled below are lost when their chunks load. Keep the
					snapshot below.
				</p>
				<div class="check">
					<input id="confirm-migrate" name="confirmMinecraft" type="checkbox" bind:checked={confirmMinecraft} />
					<label for="confirm-migrate">I understand the world may be damaged</label>
				</div>
			</div>
		{/if}

		<ul class="summary">
			<li>
				{labelOf(plan.current.loader)} {plan.current.loaderVersion ?? ''} on {plan.current.minecraft} →
				<strong>{labelOf(plan.target.loader)} {plan.target.loaderVersion ?? (plan.target.loader === 'vanilla' ? '' : '(newest)')} on {plan.target.minecraft}</strong>,
				Java {plan.requiredJava}
			</li>
			<li>
				Mods: <strong>{of('update').length}</strong> moved to a build for it, <strong>{of('disable').length}</strong> disabled,
				{of('keep').length} unchanged{plan.dependencies.install.length ? `, ${plan.dependencies.install.length} dependencies added` : ''}
			</li>
			<li>Configs, the world and <code>server.properties</code> are left as they are.</li>
		</ul>

		{#if of('disable').length}
			<h3>Disabled</h3>
			<p class="small muted">No build for the target, or not from a platform MineShell can ask. They stay in <code>mods/</code> as <code>.disabled</code>; replace or re-enable them on the Mods tab.</p>
			<ul class="mods">
				{#each of('disable') as m (m.fileName)}
					<li class="off"><strong>{m.name}</strong> <span class="muted small">{m.reason}</span></li>
				{/each}
			</ul>
		{/if}
		{#if of('update').length}
			<details>
				<summary>Moved to a build for {plan.target.minecraft} ({of('update').length})</summary>
				<ul class="mods">
					{#each of('update') as m (m.fileName)}
						<li><strong>{m.name}</strong> {m.from ?? '?'} → {m.to}{m.disabled ? ' (stays disabled)' : ''}</li>
					{/each}
				</ul>
			</details>
		{/if}
		{#if plan.dependencies.install.length}
			<details>
				<summary>Dependencies added ({plan.dependencies.install.length})</summary>
				<ul class="mods">
					{#each plan.dependencies.install as d (d.name)}
						<li><strong>{d.name}</strong> {d.versionNumber} <span class="muted small">for {d.neededBy.join(', ')}</span></li>
					{/each}
				</ul>
			</details>
		{/if}
		{#if plan.dependencies.unresolved.length}
			<p class="warn-text small">
				Needed but not available: {plan.dependencies.unresolved.map((u) => `${u.name} (for ${u.neededBy.join(', ')})`).join('; ')}.
			</p>
		{/if}
		{#if of('keep').length}
			<details>
				<summary>Unchanged ({of('keep').length})</summary>
				<ul class="mods">
					{#each of('keep') as m (m.fileName)}
						<li><strong>{m.name}</strong> <span class="muted small">{m.reason ?? 'this build runs there too'}{m.disabled ? ' · disabled' : ''}</span></li>
					{/each}
				</ul>
			</details>
		{/if}

		<SnapshotChoice prompt={snapshotPrompt} idPrefix="migrate" />
		<JavaPrompt {form} action="migrate" />
		{#if running}
			<p class="hint">Stop the server to move it.</p>
		{/if}
		<button class="button-primary" type="submit" disabled={!canApply}>{submitting ? 'Starting' : 'Move the server'}</button>
	</form>
{/if}

<style>
	.pickers {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.pickers .field {
		flex: 1 1 10rem;
		min-width: 0;
	}

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
	.mods {
		padding-left: 1.2rem;
		font-size: 0.88rem;
		margin: var(--space-2) 0;
	}

	.mods {
		max-height: 16rem;
		overflow-y: auto;
	}

	.off strong,
	.warn-text {
		color: var(--error);
	}

	h3 {
		font-size: 0.95rem;
		margin: var(--space-3) 0 var(--space-1);
	}
</style>
