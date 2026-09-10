<script lang="ts">
	import { enhance } from '$app/forms';
	import Flash from '$lib/components/Flash.svelte';
	import DetailsDialog from '$lib/components/DetailsDialog.svelte';
	import FilterSidebar from '$lib/components/FilterSidebar.svelte';
	import { fitToViewport } from '$lib/shared/fitToViewport';
	import { formatBytes } from '$lib/shared/format';

	let { data, form } = $props();

	let filter = $state('');
	let showBrowser = $state(false);
	let pendingDelete = $state<string | null>(null);
	let showDetails = $state(false);
	let detailsTab = $state<'description' | 'changelog'>('description');

	function openDetails(tab: 'description' | 'changelog') {
		detailsTab = tab;
		showDetails = true;
	}

	const visible = $derived(
		data.mods.filter((m) => m.name.toLowerCase().includes(filter.trim().toLowerCase()))
	);

	// ---- mod browser
	let term = $state('');
	let searching = $state(false);
	let searchError = $state('');
	type Hit = {
		id: string;
		name: string;
		author: string | null;
		summary: string | null;
		iconUrl: string | null;
	};
	let hits = $state<Hit[]>([]);
	let selected = $state<Hit | null>(null);
	type Version = {
		id: string;
		versionNumber: string;
		channel: string;
		dependencies: { type: string; name: string | null }[];
	};
	let versions = $state<Version[]>([]);
	let versionId = $state('');

	type Dependency = {
		projectId: string;
		versionId: string | null;
		type: string;
		name: string;
		summary: string | null;
		installable: boolean;
		alreadyInstalled: boolean;
	};
	let dependencies = $state<Dependency[]>([]);
	let loadingDeps = $state(false);
	// Required dependencies start ticked, optional ones do not.
	let chosenDeps = $state<Record<string, boolean>>({});

	function resetBrowser() {
		term = '';
		hits = [];
		selected = null;
		versions = [];
		versionId = '';
		dependencies = [];
		chosenDeps = {};
		searchError = '';
	}

	// ---- filter sidebar
	type FilterGroupData = { id: string; label: string; options: { value: string; label: string }[] };
	let filterGroups = $state<FilterGroupData[]>([]);
	let loadingFilters = $state(true);
	let filterSelections = $state<Record<string, string[]>>({
		loaders: [...data.compatibleLoaders]
	});

	$effect(() => {
		loadingFilters = true;
		fetch('/api/mods/filters?source=modrinth&kind=mod')
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error('lookup failed'))))
			.then((body) => {
				filterGroups = body.groups ?? [];
			})
			.catch(() => {
				filterGroups = [];
			})
			.finally(() => {
				loadingFilters = false;
			});
	});

	async function search() {
		searching = true;
		searchError = '';
		selected = null;
		try {
			const params = new URLSearchParams({ source: 'modrinth', term, mc: data.minecraftVersion });
			for (const loader of filterSelections.loaders ?? []) params.append('loader', loader);
			for (const category of filterSelections.categories ?? []) {
				params.append('category', category);
			}
			for (const type of filterSelections.projectTypes ?? []) params.append('type', type);
			const res = await fetch(`/api/mods/search?${params}`);
			if (!res.ok) throw new Error('Search failed.');
			hits = (await res.json()).hits ?? [];
			if (!hits.length) searchError = 'Nothing matched. Try different terms or fewer filters.';
		} catch (err) {
			searchError = err instanceof Error ? err.message : 'Search failed.';
		} finally {
			searching = false;
		}
	}

	async function choose(hit: Hit) {
		selected = hit;
		versions = [];
		versionId = '';
		const params = new URLSearchParams({
			source: 'modrinth',
			id: hit.id,
			mc: data.minecraftVersion,
			loader: data.modloader
		});
		const res = await fetch(`/api/mods/versions?${params}`);
		if (res.ok) {
			versions = (await res.json()).versions ?? [];
			versionId = versions[0]?.id ?? '';
		}
	}

	// Resolve the picked version's dependencies to real names so each one can be
	// listed and ticked individually, rather than hidden behind one blanket
	// "install dependencies" checkbox.
	$effect(() => {
		const project = selected?.id;
		const version = versionId;
		dependencies = [];
		chosenDeps = {};
		if (!project || !version) return;

		let cancelled = false;
		loadingDeps = true;
		const params = new URLSearchParams({
			source: 'modrinth',
			id: project,
			versionId: version,
			mc: data.minecraftVersion,
			loader: data.modloader,
			instance: data.instance.id
		});
		fetch(`/api/mods/dependencies?${params}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error('lookup failed'))))
			.then((body) => {
				if (cancelled) return;
				dependencies = body.dependencies ?? [];
				const initial: Record<string, boolean> = {};
				for (const dep of dependencies) {
					initial[dep.projectId] =
						dep.type === 'required' && dep.installable && !dep.alreadyInstalled;
				}
				chosenDeps = initial;
			})
			.catch(() => {
				if (!cancelled) dependencies = [];
			})
			.finally(() => {
				if (!cancelled) loadingDeps = false;
			});

		return () => {
			cancelled = true;
		};
	});
</script>

<Flash {form} />

{#if !data.supportsMods}
	<div class="notice info">
		<p>
			This server runs {data.modloader}, which does not load mods. Change the loader in instance
			settings, or use datapacks under Files.
		</p>
	</div>
{/if}

{#if data.counts.untracked > 0 || data.counts.missing > 0}
	<div class="notice warning">
		<p>
			{#if data.counts.untracked}
				{data.counts.untracked} jar{data.counts.untracked === 1 ? '' : 's'} in the folder that
				MineShell did not install.
			{/if}
			{#if data.counts.missing}
				{data.counts.missing} record{data.counts.missing === 1 ? '' : 's'} with no matching file.
			{/if}
		</p>
		<form method="POST" action="?/sync" use:enhance>
			<button class="button-quiet" type="submit">Sync mods with database</button>
		</form>
	</div>
{/if}

<section class="panel">
	<div class="panel-head">
		<div>
			<h2>Mods</h2>
			<p>
				{data.counts.enabled} of {data.counts.total} enabled. Disabling renames the file to
				<code>.jar.disabled</code>, which is what the loader looks at.
			</p>
		</div>
		<div class="button-row">
			<button
				class="button-primary"
				onclick={() => {
					showBrowser = !showBrowser;
					if (!showBrowser) resetBrowser();
				}}
			>
				{showBrowser ? 'Close' : 'Add mods'}
			</button>
		</div>
	</div>

	{#if showBrowser}
		<div class="browser browse-layout">
			<FilterSidebar
				groups={filterGroups}
				bind:selected={filterSelections}
				loading={loadingFilters}
			/>

			<div class="browse-main">
			<div class="search-row">
				<div class="field grow">
					<label for="mod-term">Search Modrinth</label>
					<input
						id="mod-term"
						type="search"
						bind:value={term}
						placeholder="sodium, journeymap, create"
						onkeydown={(e) => e.key === 'Enter' && search()}
					/>
					<p class="hint">Minecraft {data.minecraftVersion}, filtered by the sidebar.</p>
				</div>
				<button class="button-primary find" onclick={search} disabled={searching}>
					{searching ? 'Searching' : 'Search'}
				</button>
			</div>

			{#if searchError}<p class="notice warning">{searchError}</p>{/if}

			{#if hits.length}
				<ul class="hits" use:fitToViewport={40}>
					{#each hits as hit (hit.id)}
						<li>
							<button class="hit" aria-pressed={selected?.id === hit.id} onclick={() => choose(hit)}>
								{#if hit.iconUrl}
									<img src={hit.iconUrl} alt="" width="32" height="32" loading="lazy" />
								{:else}
									<span class="icon-fallback" aria-hidden="true"></span>
								{/if}
								<span class="hit-body">
									<strong>{hit.name}</strong>
									<span class="small muted summary">{hit.summary ?? ''}</span>
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}

			{#if selected}
				<form
					method="POST"
					action="?/install"
					class="install"
					use:enhance={() => {
						return async ({ result, update }) => {
							await update();
							// A finished install should leave the browser out of the
							// way rather than sitting there on the mod just added.
							if (result.type === 'success') {
								resetBrowser();
								showBrowser = false;
							}
						};
					}}
				>
					<input type="hidden" name="source" value="modrinth" />
					<input type="hidden" name="projectId" value={selected.id} />
					<p class="selected-name"><strong>{selected.name}</strong></p>

					<div class="version-row">
						<div class="field version-field">
							<label for="mod-version">Version</label>
							<select id="mod-version" name="versionId" bind:value={versionId} required>
								{#each versions as v (v.id)}
									<option value={v.id}>
										{v.versionNumber}{v.channel !== 'release' ? ` (${v.channel})` : ''}
									</option>
								{/each}
							</select>
						</div>
						<div class="detail-buttons">
							<button type="button" onclick={() => openDetails('description')}>Description</button>
							<button type="button" onclick={() => openDetails('changelog')}>Changelog</button>
						</div>
					</div>

					{#if loadingDeps}
						<p class="muted small">Checking dependencies.</p>
					{:else if dependencies.length}
						<fieldset class="deps">
							<legend>Dependencies</legend>
							{#each dependencies as dep (dep.projectId)}
								<div class="dep">
									<input
										id="dep-{dep.projectId}"
										type="checkbox"
										disabled={!dep.installable}
										bind:checked={chosenDeps[dep.projectId]}
									/>
									{#if chosenDeps[dep.projectId] && dep.versionId}
										<input
											type="hidden"
											name="dependency"
											value="{dep.projectId}:{dep.versionId}"
										/>
									{/if}
									<label for="dep-{dep.projectId}">
										<span class="dep-name">
											{dep.name}
											<span class="tag" class:warn={dep.type === 'required'}>{dep.type}</span>
											{#if dep.alreadyInstalled}
												<span class="tag ok">installed</span>
											{/if}
										</span>
										{#if dep.summary}
											<span class="small muted dep-summary">{dep.summary}</span>
										{/if}
										{#if dep.alreadyInstalled}
											<span class="small muted">Already in this instance.</span>
										{:else if !dep.installable}
											<span class="small warn-text">
												No build for {data.modloader}
												{data.minecraftVersion}. Install it by hand if the mod needs it.
											</span>
										{/if}
									</label>
								</div>
							{/each}
						</fieldset>
					{/if}

					<button class="button-primary install-submit" type="submit" disabled={!versionId}>
						Install
					</button>
				</form>
			{/if}

			{#if showDetails && selected}
				<DetailsDialog
					source="modrinth"
					projectId={selected.id}
					{versionId}
					versionLabel={versions.find((v) => v.id === versionId)?.versionNumber ?? ''}
					defaultTab={detailsTab}
					onClose={() => (showDetails = false)}
				/>
			{/if}
			</div>
		</div>
	{/if}

	<div class="list-controls">
		<input type="search" placeholder="Filter installed mods" bind:value={filter} />
		<form method="POST" action="?/upload" enctype="multipart/form-data" use:enhance class="upload">
			<input type="file" name="jars" accept=".jar" multiple aria-label="Upload jar files" />
			<button type="submit">Upload jars</button>
		</form>
	</div>

	{#if visible.length === 0}
		<div class="empty">
			<p>
				{data.mods.length === 0
					? 'No mods installed. Search Modrinth above, or upload a jar.'
					: 'Nothing matches that filter.'}
			</p>
		</div>
	{:else}
		<table>
			<thead>
				<tr>
					<th>Mod</th>
					<th class="nowrap">Version</th>
					<th class="nowrap">Source</th>
					<th class="nowrap">Size</th>
					<th><span class="visually-hidden">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				{#each visible as mod (mod.filePath)}
					<tr class:disabled={!mod.enabled} class:missing={mod.missing}>
						<td>
							<div class="mod-name">
								{#if mod.projectUrl}
									<a href={mod.projectUrl} target="_blank" rel="noreferrer">{mod.name}</a>
								{:else}
									<span>{mod.name}</span>
								{/if}
								{#if mod.fromPack}<span class="tag">pack</span>{/if}
								{#if mod.untracked}<span class="tag warn">untracked</span>{/if}
								{#if mod.missing}<span class="tag bad">file missing</span>{/if}
								{#if mod.locked}<span class="tag">locked</span>{/if}
							</div>
							<div class="faint small mono">{mod.fileName}</div>
						</td>
						<td class="mono small nowrap">{mod.version ?? '-'}</td>
						<td class="small nowrap">{mod.source}</td>
						<td class="mono small nowrap">{mod.sizeBytes ? formatBytes(mod.sizeBytes) : '-'}</td>
						<td>
							{#if pendingDelete === mod.fileName}
								<div class="row-actions confirm">
									<span class="small">Delete this mod?</span>
									<form
										method="POST"
										action="?/remove"
										use:enhance={() => async ({ update }) => {
											pendingDelete = null;
											await update();
										}}
									>
										<input type="hidden" name="fileName" value={mod.fileName} />
										<button class="button-danger" type="submit">Yes, delete</button>
									</form>
									<button type="button" onclick={() => (pendingDelete = null)}>Cancel</button>
								</div>
							{:else}
								<div class="row-actions">
									{#if !mod.missing}
										<form method="POST" action="?/toggle" use:enhance>
											<input type="hidden" name="fileName" value={mod.fileName} />
											<input type="hidden" name="enabled" value={String(!mod.enabled)} />
											<button type="submit">{mod.enabled ? 'Disable' : 'Enable'}</button>
										</form>
									{/if}
									<button
										type="button"
										class="button-danger"
										onclick={() => (pendingDelete = mod.fileName)}
									>
										Delete
									</button>
								</div>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<style>
	.browser {
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-4);
		margin-bottom: var(--space-4);
		background: var(--bg-sunken);
	}

	.browse-layout {
		display: flex;
		align-items: flex-start;
		gap: var(--space-4);
		/* Never collapse the browser below a usable size, even in a short
		   window or above a tall installed-mods list. The sidebar and .hits
		   below each cap their own height via the fitToViewport action
		   (measures real remaining space) rather than depending on this row
		   stretching them to a shared height. */
		min-height: 22rem;
	}

	.browse-layout :global(.sidebar) {
		flex: 0 0 12rem;
	}

	.browse-main {
		flex: 1 1 auto;
		min-width: 0;
	}

	.search-row {
		display: flex;
		gap: var(--space-3);
		align-items: flex-end;
		flex-wrap: wrap;
	}

	.grow {
		flex: 1 1 16rem;
		margin-bottom: 0;
	}

	.find {
		height: 2.15rem;
	}

	.hits {
		list-style: none;
		margin: var(--space-3) 0 0;
		padding: 0;
		overflow-y: auto;
		/* Was a fixed max-height, capping the list well short of the sidebar
		   next to it however tall the window was. fitToViewport (see the
		   use: directive on this element) now measures the real remaining
		   space instead of a guessed number. */
		min-height: 10rem;
	}

	.hit {
		display: flex;
		/* The global button rule centres its content; these are list rows, so the
		   icon must stay pinned left regardless of how long the name is. */
		justify-content: flex-start;
		gap: var(--space-3);
		width: 100%;
		text-align: left;
		align-items: flex-start;
		background: none;
		border: 1px solid transparent;
		padding: var(--space-2);
		font-weight: 400;
		white-space: normal;
	}

	.hit:hover,
	.hit[aria-pressed='true'] {
		background: var(--panel);
		border-color: var(--line-strong);
	}
	.hit[aria-pressed='true'] {
		border-color: var(--accent);
	}

	.hit img,
	.icon-fallback {
		width: 32px;
		height: 32px;
		flex: 0 0 32px;
		border-radius: var(--radius);
		background: var(--panel-raised);
		object-fit: cover;
	}

	.hit-body {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.summary {
		display: -webkit-box;
		-webkit-line-clamp: 1;
		line-clamp: 1;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.install {
		margin-top: var(--space-4);
		padding-top: var(--space-3);
		border-top: 1px solid var(--line);
	}

	.selected-name {
		margin: 0 0 var(--space-3);
	}

	.version-row {
		display: flex;
		align-items: flex-end;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.version-field {
		flex: 1 1 auto;
		max-width: 50%;
		margin-bottom: 0;
	}

	.detail-buttons {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.detail-buttons button {
		font-size: 0.82rem;
		white-space: nowrap;
	}

	.install-submit {
		margin-top: var(--space-4);
	}

	.install .check {
		margin-top: var(--space-3);
	}

	.list-controls {
		display: flex;
		gap: var(--space-3);
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}

	.list-controls input[type='search'] {
		flex: 1 1 14rem;
	}

	.upload {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		flex-wrap: wrap;
	}

	.upload input[type='file'] {
		width: auto;
		font-size: 0.8rem;
		padding: 0.25rem;
	}

	.mod-name {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	tr.disabled td {
		opacity: 0.55;
	}

	tr.missing td {
		opacity: 0.8;
	}

	.row-actions {
		display: flex;
		gap: var(--space-2);
		justify-content: flex-end;
		align-items: center;
	}

	/* These were quiet (transparent until hover), which made them easy to miss
	   in a long list. They read as real buttons now. */
	.row-actions button {
		font-size: 0.82rem;
		padding: 0.25rem 0.6rem;
		background: var(--panel-raised);
		border: 1px solid var(--line-strong);
		color: var(--text);
	}

	.row-actions button:hover {
		border-color: var(--accent);
		color: var(--accent-hover);
	}

	/* Destructive actions read as destructive without needing a hover first. */
	.row-actions button.button-danger {
		color: var(--error);
		border-color: color-mix(in srgb, var(--error) 45%, var(--line-strong));
	}

	.row-actions button.button-danger:hover {
		border-color: var(--error);
		background: color-mix(in srgb, var(--error) 12%, transparent);
	}

	.tag.ok {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 45%, var(--line-strong));
	}

	.row-actions.confirm {
		gap: var(--space-2);
	}

	.row-actions.confirm span {
		color: var(--text-muted);
		white-space: nowrap;
	}

	/* --- dependency picker --- */

	.deps {
		margin-top: var(--space-4);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-3);
	}

	.deps legend {
		font-size: 0.8rem;
		color: var(--text-faint);
		padding: 0 var(--space-2);
	}

	.dep {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		padding: var(--space-1) 0;
	}

	.dep input[type='checkbox'] {
		margin-top: 0.3rem;
		flex: 0 0 auto;
	}

	.dep label {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		margin: 0;
		cursor: pointer;
		min-width: 0;
	}

	.dep-name {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--text);
		font-size: 0.9rem;
	}

	.dep-summary {
		display: -webkit-box;
		-webkit-line-clamp: 1;
		line-clamp: 1;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.warn-text {
		color: var(--warning);
	}
</style>
