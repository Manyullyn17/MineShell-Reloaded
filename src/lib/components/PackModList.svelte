<script lang="ts">
	/**
	 * The mods a pack version installs, before installing it. Ticked ones are
	 * installed enabled; unticked ones are still installed, but disabled, so
	 * they can be turned on later from the Mods tab. Client-only mods start
	 * unticked unless another mod of the pack requires them.
	 *
	 * Mods the pack itself ships disabled start unticked too.
	 *
	 * Sends `disableMods` (unticked, not client-only), `keepMods` (client-only
	 * but ticked) and `enableMods` (shipped disabled, ticked); unticked
	 * client-only mods are left to the install's own client-only check, which
	 * also catches the ones only their jar declares.
	 */
	type Mod = { target: string; fileName: string; name: string; clientOnly: string | null; packDisabled: boolean; neededBy: string[] };
	type Preview = { mods: Mod[]; otherFiles: number };

	let { preview, loading = false, error = '' }: { preview: Preview | null; loading?: boolean; error?: string } = $props();

	let enabled = $state<Record<string, boolean>>({});
	$effect(() => {
		enabled = Object.fromEntries(
			(preview?.mods ?? []).map((m) => [m.target, !m.packDisabled && (!m.clientOnly || m.neededBy.length > 0)])
		);
	});

	let filter = $state('');
	const mods = $derived(preview?.mods ?? []);
	const shown = $derived(
		filter.trim()
			? mods.filter((m) => `${m.name} ${m.fileName}`.toLowerCase().includes(filter.trim().toLowerCase()))
			: mods
	);
	const disabledCount = $derived(mods.filter((m) => enabled[m.target] === false).length);
	const clientOnlyOff = $derived(mods.filter((m) => m.clientOnly && enabled[m.target] === false).length);
	const packOff = $derived(mods.filter((m) => m.packDisabled && enabled[m.target] === false).length);
	/** "(client-only)", "(3 client-only, 2 off in the pack)" - whichever apply. */
	function reasons(clientOnly: number, pack: number, total: number): string {
		const parts = [
			clientOnly ? `${clientOnly === total ? '' : `${clientOnly} `}client-only` : '',
			pack ? `${pack === total ? '' : `${pack} `}off in the pack` : ''
		].filter(Boolean);
		return parts.length ? ` (${parts.join(', ')})` : '';
	}

	const off = (m: Mod) => enabled[m.target] === false;
	const disableMods = $derived(mods.filter((m) => !m.clientOnly && !m.packDisabled && off(m)).map((m) => m.target));
	const keepMods = $derived(mods.filter((m) => m.clientOnly && !off(m)).map((m) => m.target));
	const enableMods = $derived(mods.filter((m) => m.packDisabled && !off(m)).map((m) => m.target));
</script>

<div class="field pack-mods">
	{#if loading}
		<p class="small muted">Reading the pack's mod list.</p>
	{:else if error}
		<p class="small muted">Could not read the pack's mod list ({error}). It installs as usual; client-only mods are still found and disabled afterwards.</p>
	{:else if preview}
		<details>
			<summary>
				<span>Mods <span class="muted">({mods.length})</span></span>
				{#if disabledCount}
					<span class="small muted">
						· {disabledCount} installed disabled{reasons(clientOnlyOff, packOff, disabledCount)}
					</span>
				{/if}
			</summary>
			<p class="hint">
				Unticked mods are installed disabled; turn them on later from the Mods tab. Client-only mods do nothing on a
				server or crash it, so they start unticked, as do mods the pack itself ships disabled.
			</p>
			{#if mods.length > 12}
				<input class="filter" type="search" placeholder="Filter mods" bind:value={filter} />
			{/if}
			<ul>
				{#each shown as mod (mod.target)}
					<li>
						<label>
							<input type="checkbox" bind:checked={enabled[mod.target]} />
							<span class="name">{mod.name}</span>
							{#if mod.clientOnly}
								<span class="tag warn" title={mod.clientOnly}>client-only</span>
							{/if}
							{#if mod.packDisabled}
								<span class="tag" title="The pack ships this mod disabled">off in the pack</span>
							{/if}
							{#if mod.neededBy.length}
								<span class="small muted">needed by {mod.neededBy.join(', ')}</span>
							{/if}
							<span class="small faint mono file">{mod.fileName}</span>
						</label>
					</li>
				{:else}
					<li class="small muted">{mods.length ? 'No mod matches that.' : 'This version lists no mods.'}</li>
				{/each}
			</ul>
			{#if preview.otherFiles}
				<p class="hint">Plus {preview.otherFiles} other file{preview.otherFiles === 1 ? '' : 's'} and the pack's overrides (configs, scripts).</p>
			{/if}
		</details>
	{/if}
	<input type="hidden" name="disableMods" value={JSON.stringify(disableMods)} />
	<input type="hidden" name="keepMods" value={JSON.stringify(keepMods)} />
	<input type="hidden" name="enableMods" value={JSON.stringify(enableMods)} />
</div>

<style>
	.pack-mods {
		max-width: 40rem;
	}

	summary {
		cursor: pointer;
		font-size: 0.9rem;
	}

	.filter {
		margin: 0 0 var(--space-2);
		max-width: 16rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: var(--space-1);
		max-height: 18rem;
		overflow-y: auto;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--bg-sunken);
	}

	label {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		padding: 0.2rem var(--space-1);
		color: var(--text);
		font-size: 0.88rem;
		cursor: pointer;
	}

	label:hover {
		background: var(--panel-raised);
	}

	.file {
		margin-left: auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 45%;
	}
</style>
