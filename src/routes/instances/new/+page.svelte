<script lang="ts">
	import Flash from '$lib/components/Flash.svelte';
	import DetailsDialog from '$lib/components/DetailsDialog.svelte';
	import FilterSidebar from '$lib/components/FilterSidebar.svelte';
	import { fitToViewport } from '$lib/shared/fitToViewport';

	let { data, form } = $props();

	type Mode = 'browse' | 'upload' | 'loader';
	let mode = $state<Mode>('browse');
	let submitting = $state(false);

	// ---- shared fields
	let name = $state('');
	let nameTouched = $state(false);
	// Seeded from load data but user-editable afterwards, so it tracks a change
	// of suggestion without discarding an edit already in progress.
	let memoryMaxMb = $state(data.suggestedMaxMb);
	let memoryTouched = $state(false);
	$effect(() => {
		const suggested = data.suggestedMaxMb;
		if (!memoryTouched) memoryMaxMb = suggested;
	});
	let memoryMinMb = $state(1024);

	// ---- loader-only mode
	let minecraftVersion = $state(data.minecraftVersions[0] ?? '');
	let versionTouched = $state(false);
	$effect(() => {
		const first = data.minecraftVersions[0] ?? '';
		if (!versionTouched && !minecraftVersion) minecraftVersion = first;
	});
	let modloader = $state('fabric');
	let loaderVersions = $state<string[]>([]);
	let modloaderVersion = $state('');
	let loaderVersionError = $state('');

	$effect(() => {
		const mc = minecraftVersion;
		const loader = modloader;
		modloaderVersion = '';
		loaderVersions = [];
		loaderVersionError = '';
		if (!mc || loader === 'vanilla') return;

		let cancelled = false;
		fetch(`/api/loaders/versions?loader=${loader}&mc=${encodeURIComponent(mc)}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error('lookup failed'))))
			.then((body) => {
				if (!cancelled) loaderVersions = body.versions ?? [];
			})
			.catch(() => {
				if (!cancelled) {
					loaderVersionError =
						'Could not reach the loader metadata server. Leave the version blank to take the latest, or type one in.';
				}
			});
		return () => {
			cancelled = true;
		};
	});

	// ---- browse mode
	let source = $state('modrinth');
	let term = $state('');
	let searching = $state(false);
	let searchError = $state('');
	type Hit = {
		id: string;
		name: string;
		author: string | null;
		summary: string | null;
		iconUrl: string | null;
		downloads: number | null;
		loaders: string[];
		gameVersions: string[];
	};
	let hits = $state<Hit[]>([]);
	let selected = $state<Hit | null>(null);
	let showDetails = $state(false);
	let detailsTab = $state<'description' | 'changelog'>('description');

	function openDetails(tab: 'description' | 'changelog') {
		detailsTab = tab;
		showDetails = true;
	}

	// Switching source left the previous provider's results on screen, which
	// looked like the new source had returned them. Minecraft version isn't
	// source-specific, so that part of the selection survives the reset.
	// This also runs once on mount (lastSource starts equal to source), which
	// is what gets a first page of results showing without pressing Search.
	let lastSource = $state(source);
	$effect(() => {
		const current = source;
		if (current !== lastSource) {
			lastSource = current;
			hits = [];
			selected = null;
			packVersions = [];
			versionId = '';
			searchError = '';
			filterSelections = { minecraftVersions: filterSelections.minecraftVersions ?? [] };
			void search();
		}
	});

	// ---- filter sidebar
	type FilterGroupData = { id: string; label: string; options: { value: string; label: string }[] };
	let filterGroups = $state<FilterGroupData[]>([]);
	let filterSelections = $state<Record<string, string[]>>({});
	let loadingFilters = $state(false);

	// Minecraft version applies to every source the same way, so it's built
	// client-side from the version list already loaded for the page rather
	// than through the per-source /api/mods/filters round trip.
	const versionFilterGroup = $derived({
		id: 'minecraftVersions',
		label: 'Minecraft version',
		options: data.minecraftVersions.map((v) => ({ value: v, label: v }))
	});
	const combinedFilterGroups = $derived([versionFilterGroup, ...filterGroups]);

	$effect(() => {
		const currentSource = source;
		loadingFilters = true;
		let cancelled = false;
		fetch(`/api/mods/filters?source=${currentSource}&kind=modpack`)
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error('lookup failed'))))
			.then((body) => {
				if (!cancelled) filterGroups = body.groups ?? [];
			})
			.catch(() => {
				if (!cancelled) filterGroups = [];
			})
			.finally(() => {
				if (!cancelled) loadingFilters = false;
			});
		return () => {
			cancelled = true;
		};
	});

	// CurseForge/FTB take one tag, one loader, and one game version per
	// browse request, not a real facet system - only the first checked box
	// in each group applies there. Searching by name is different: it goes
	// through a plain id search, so every loader/version you've picked is
	// applied afterward against the results, not just the first.
	const filterLimitNote = $derived(
		source === 'modrinth'
			? ''
			: 'Browsing without a search term only applies the first checked loader, category, and version. Searching by name applies every one you\'ve picked.'
	);

	/** Newest-first, de-duplicated, and trimmed - packs can list dozens. */
	function summariseVersions(list: string[]): string {
		const unique = [...new Set(list)];
		if (unique.length === 0) return '';
		if (unique.length <= 3) return unique.join(', ');
		return `${unique.slice(0, 3).join(', ')} +${unique.length - 3}`;
	}

	type PackVersion = {
		id: string;
		name: string;
		versionNumber: string;
		channel: string;
		gameVersions: string[];
		loaders: string[];
	};
	let packVersions = $state<PackVersion[]>([]);
	let versionId = $state('');
	let loadingVersions = $state(false);

	async function search() {
		searching = true;
		searchError = '';
		selected = null;
		packVersions = [];
		try {
			const params = new URLSearchParams({ source, term });
			for (const version of filterSelections.minecraftVersions ?? []) params.append('mc', version);
			for (const loader of filterSelections.loaders ?? []) params.append('loader', loader);
			for (const category of filterSelections.categories ?? []) {
				params.append('category', category);
			}
			const res = await fetch(`/api/packs/search?${params}`);
			if (!res.ok) throw new Error((await res.json()).message ?? 'Search failed.');
			hits = (await res.json()).hits ?? [];
			if (hits.length === 0) searchError = 'Nothing matched. Try different terms or fewer filters.';
		} catch (err) {
			searchError = err instanceof Error ? err.message : 'Search failed.';
			hits = [];
		} finally {
			searching = false;
		}
	}

	async function choose(hit: Hit) {
		selected = hit;
		if (!nameTouched) name = hit.name;
		loadingVersions = true;
		packVersions = [];
		versionId = '';
		try {
			const res = await fetch(`/api/packs/versions?source=${source}&id=${encodeURIComponent(hit.id)}`);
			if (!res.ok) throw new Error('Could not list versions for that pack.');
			packVersions = (await res.json()).versions ?? [];
			versionId = packVersions[0]?.id ?? '';
		} catch (err) {
			searchError = err instanceof Error ? err.message : 'Could not list versions.';
		} finally {
			loadingVersions = false;
		}
	}

	const sources = [
		{ id: 'modrinth', label: 'Modrinth' },
		{ id: 'curseforge', label: 'CurseForge' },
		{ id: 'ftb', label: 'Feed the Beast' }
	];
</script>

<svelte:head><title>Add a server - MineShell</title></svelte:head>

<header class="page-head">
	<h1>Add a server</h1>
	<p class="muted">
		Installing a large pack pulls a few hundred megabytes and takes a while. You can leave the page
		once it starts.
	</p>
</header>

<Flash {form} />

<div class="tabs" role="tablist">
	<button role="tab" aria-selected={mode === 'browse'} onclick={() => (mode = 'browse')}>
		Browse modpacks
	</button>
	<button role="tab" aria-selected={mode === 'upload'} onclick={() => (mode = 'upload')}>
		Upload a pack file
	</button>
	<button role="tab" aria-selected={mode === 'loader'} onclick={() => (mode = 'loader')}>
		Mod loader only
	</button>
</div>

{#snippet memoryFields()}
	<div class="grid-2">
		<div class="field">
			<label for="memoryMaxMb">Maximum memory (MB)</label>
			<input
				id="memoryMaxMb"
				name="memoryMaxMb"
				type="number"
				min="512"
				step="256"
				bind:value={memoryMaxMb}
				oninput={() => (memoryTouched = true)}
			/>
			<p class="hint">Large modpacks want 6144 or more. Leave room for the rest of the machine.</p>
		</div>
		<div class="field">
			<label for="memoryMinMb">Starting memory (MB)</label>
			<input id="memoryMinMb" name="memoryMinMb" type="number" min="256" step="256" bind:value={memoryMinMb} />
		</div>
	</div>
{/snippet}

{#if mode === 'browse'}
	<div class="browse-layout">
		<FilterSidebar
			groups={combinedFilterGroups}
			bind:selected={filterSelections}
			loading={loadingFilters}
			limitNote={filterLimitNote}
		/>

	<section class="panel browse-panel">
		<div class="search-row">
			<div class="field source">
				<label for="source">Source</label>
				<select id="source" bind:value={source}>
					{#each sources as s (s.id)}
						<option value={s.id}>{s.label}</option>
					{/each}
				</select>
			</div>
			<div class="field grow">
				<label for="term">Search</label>
				<input
					id="term"
					type="search"
					placeholder="Pack name, or leave blank to browse popular packs"
					bind:value={term}
					onkeydown={(e) => e.key === 'Enter' && search()}
				/>
			</div>
			<button class="button-primary find" onclick={search} disabled={searching}>
				{searching ? 'Searching' : 'Search'}
			</button>
		</div>

		{#if searchError}
			<p class="notice warning">{searchError}</p>
		{/if}

		{#if hits.length}
			<ul class="hits" use:fitToViewport={40}>
				{#each hits as hit (hit.id)}
					<li>
						<button class="hit" aria-pressed={selected?.id === hit.id} onclick={() => choose(hit)}>
							{#if hit.iconUrl}
								<img src={hit.iconUrl} alt="" width="40" height="40" loading="lazy" />
							{:else}
								<span class="icon-fallback" aria-hidden="true"></span>
							{/if}
							<span class="hit-body">
								<span class="hit-title">
									<strong>{hit.name}</strong>
									{#if hit.author}<span class="faint small">by {hit.author}</span>{/if}
								</span>
								<span class="small muted summary">{hit.summary ?? ''}</span>
								{#if hit.loaders?.length || hit.gameVersions?.length}
									<span class="hit-meta">
										{#each [...new Set(hit.loaders ?? [])].slice(0, 2) as loader (loader)}
											<span class="tag accent">{loader}</span>
										{/each}
										{#if hit.gameVersions?.length}
											<span class="tag">{summariseVersions(hit.gameVersions)}</span>
										{/if}
									</span>
								{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}

		{#if selected}
			<form method="POST" action="?/install" class="install" onsubmit={() => (submitting = true)}>
				<input type="hidden" name="source" value={source} />
				<input type="hidden" name="projectId" value={selected.id} />

				<h2 class="selected-name">{selected.name}</h2>

				<div class="name-row">
					<div class="field name-field">
						<label for="pack-name">Server name</label>
						<input
							id="pack-name"
							name="name"
							bind:value={name}
							oninput={() => (nameTouched = true)}
							required
						/>
					</div>
					<div class="detail-buttons">
						<button type="button" onclick={() => openDetails('description')}>Description</button>
						<button type="button" onclick={() => openDetails('changelog')}>Changelog</button>
					</div>
				</div>

				<div class="field version-field">
					<label for="versionId">Pack version</label>
					{#if loadingVersions}
						<p class="muted small">Loading versions.</p>
					{:else if packVersions.length === 0}
						<p class="muted small">No versions were returned for this pack.</p>
					{:else}
						<select id="versionId" name="versionId" bind:value={versionId} required>
							{#each packVersions as v (v.id)}
								<option value={v.id}>
									{v.versionNumber}
									{v.gameVersions.length ? ` - MC ${v.gameVersions.join(', ')}` : ''}
									{v.channel !== 'release' ? ` (${v.channel})` : ''}
								</option>
							{/each}
						</select>
					{/if}
				</div>

				{@render memoryFields()}

				<button class="button-primary" type="submit" disabled={submitting || !versionId}>
					{submitting ? 'Starting install' : 'Install pack'}
				</button>
			</form>
		{/if}
	</section>

	</div>

	{#if showDetails && selected}
		<DetailsDialog
			{source}
			projectId={selected.id}
			{versionId}
			versionLabel={packVersions.find((v) => v.id === versionId)?.versionNumber ?? ''}
			defaultTab={detailsTab}
			onClose={() => (showDetails = false)}
		/>
	{/if}
{/if}

{#if mode === 'upload'}
	<form
		class="panel"
		method="POST"
		action="?/upload"
		enctype="multipart/form-data"
		onsubmit={() => (submitting = true)}
	>
		<p class="muted">
			MineShell reads Modrinth <code>.mrpack</code> files and CurseForge server pack zips. Use this
			when a pack is not listed, or when you have a custom export.
		</p>

		<div class="field">
			<label for="archive">Pack file</label>
			<input id="archive" name="archive" type="file" accept=".mrpack,.zip" required />
		</div>

		<div class="field">
			<label for="upload-name">Server name</label>
			<input id="upload-name" name="name" bind:value={name} placeholder="Taken from the pack if left blank" />
		</div>

		{@render memoryFields()}

		<button class="button-primary" type="submit" disabled={submitting}>
			{submitting ? 'Uploading' : 'Install pack'}
		</button>
	</form>
{/if}

{#if mode === 'loader'}
	<form class="panel" method="POST" action="?/loader" onsubmit={() => (submitting = true)}>
		<div class="field">
			<label for="loader-name">Server name</label>
			<input id="loader-name" name="name" bind:value={name} required placeholder="Survival world" />
		</div>

		<div class="field">
			<span class="label-text">Mod loader</span>
			<div class="loader-grid">
				{#each data.loaders as loader (loader.id)}
					<label class="loader-option" class:selected={modloader === loader.id}>
						<input type="radio" name="modloader" value={loader.id} bind:group={modloader} />
						<span>
							<strong>{loader.label}</strong>
							<span class="small muted">{loader.blurb}</span>
						</span>
					</label>
				{/each}
			</div>
		</div>

		<div class="grid-2">
			<div class="field">
				<label for="minecraftVersion">Minecraft version</label>
				{#if data.minecraftVersions.length}
					<select
						id="minecraftVersion"
						name="minecraftVersion"
						bind:value={minecraftVersion}
						onchange={() => (versionTouched = true)}
						required
					>
						{#each data.minecraftVersions as version (version)}
							<option value={version}>{version}</option>
						{/each}
					</select>
				{:else}
					<input id="minecraftVersion" name="minecraftVersion" bind:value={minecraftVersion} placeholder="1.21.1" required />
					<p class="hint">Mojang's version list was unreachable, so type the version.</p>
				{/if}
			</div>

			{#if modloader !== 'vanilla'}
				<div class="field">
					<label for="modloaderVersion">Loader version</label>
					{#if loaderVersions.length}
						<select id="modloaderVersion" name="modloaderVersion" bind:value={modloaderVersion}>
							<option value="">Latest ({loaderVersions[0]})</option>
							{#each loaderVersions.slice(0, 40) as version (version)}
								<option value={version}>{version}</option>
							{/each}
						</select>
					{:else}
						<input id="modloaderVersion" name="modloaderVersion" bind:value={modloaderVersion} placeholder="Leave blank for the latest" />
					{/if}
					{#if loaderVersionError}
						<p class="hint">{loaderVersionError}</p>
					{/if}
				</div>
			{/if}
		</div>

		{@render memoryFields()}

		{#if data.javaRuntimes.length > 1}
			<div class="field">
				<label for="javaPath">Java runtime</label>
				<select id="javaPath" name="javaPath">
					<option value="">Match automatically to the Minecraft version</option>
					{#each data.javaRuntimes as java (java.path)}
						<option value={java.path}>Java {java.majorVersion} - {java.path}</option>
					{/each}
				</select>
			</div>
		{/if}

		<button class="button-primary" type="submit" disabled={submitting}>
			{submitting ? 'Creating' : 'Create server'}
		</button>
	</form>
{/if}

<style>
	.page-head {
		margin-bottom: var(--space-5);
	}
	.page-head p {
		margin: var(--space-2) 0 0;
	}

	.tabs {
		display: flex;
		gap: var(--space-1);
		margin-bottom: var(--space-4);
		border-bottom: 1px solid var(--line);
		flex-wrap: wrap;
	}

	.tabs button {
		background: none;
		border: 0;
		border-bottom: 2px solid transparent;
		border-radius: 0;
		color: var(--text-muted);
		padding: var(--space-2) var(--space-3);
	}

	.tabs button[aria-selected='true'] {
		color: var(--text);
		border-bottom-color: var(--accent);
	}

	.search-row {
		display: flex;
		gap: var(--space-3);
		align-items: flex-end;
		flex-wrap: wrap;
		margin-bottom: var(--space-4);
	}

	.search-row .field {
		margin-bottom: 0;
	}
	.source {
		width: 11rem;
	}
	.grow {
		flex: 1 1 16rem;
	}
	.find {
		height: 2.15rem;
	}

	/* Sidebar plus the search/results/install column. An earlier version
	   tried viewport-height math directly on this panel (guessed the
	   surrounding chrome's height wrong twice) and then gave up on filling
	   the screen at all, capping the results list at a fixed height instead.
	   The sidebar and .hits below each cap their own height via the
	   fitToViewport action (measures real remaining space) rather than
	   depending on this row stretching them to a shared height - min-height
	   here is just the floor for a short viewport. */
	.browse-layout {
		display: flex;
		align-items: flex-start;
		gap: var(--space-5);
		min-height: 22rem;
	}

	.browse-layout :global(.sidebar) {
		flex: 0 0 13rem;
		position: sticky;
		top: var(--space-4);
	}

	.browse-panel {
		flex: 1 1 auto;
		min-width: 0;
	}

	.hits {
		list-style: none;
		margin: 0 0 var(--space-4);
		padding: 0;
		display: grid;
		gap: var(--space-1);
		overflow-y: auto;
		min-height: 10rem;
		align-content: start;
	}

	/* Nothing searched yet, or nothing matched: a short hint rather than a
	   tall empty box reserving space for a list that has nothing in it. */
	.empty-hint {
		padding: var(--space-3) 0;
	}

	.hit-title {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.hit-meta {
		display: flex;
		gap: var(--space-1);
		flex-wrap: wrap;
		margin-top: 0.25rem;
	}

	.memory-fields {
		margin-top: var(--space-4);
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
		background: var(--panel-raised);
		border-color: var(--line-strong);
	}

	.hit[aria-pressed='true'] {
		border-color: var(--accent);
	}

	.hit img,
	.icon-fallback {
		width: 40px;
		height: 40px;
		border-radius: var(--radius);
		background: var(--bg-sunken);
		flex: 0 0 40px;
		object-fit: cover;
	}

	.hit-body {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.summary {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.install {
		border-top: 1px solid var(--line);
		padding-top: var(--space-4);
	}

	.selected-name {
		margin: 0 0 var(--space-4);
	}

	/* Server name is the reference width everything else in this form is
	   sized against - fixed in rem rather than left fluid, so "2x that" and
	   "same as that" below are both real, stable numbers instead of guesses
	   at whatever the container happens to be. */
	.install .name-row {
		display: flex;
		align-items: flex-end;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.install .name-field {
		max-width: 20rem;
	}

	.install .grid-2 {
		grid-template-columns: repeat(auto-fit, 20rem);
	}

	.version-field {
		flex: 1 1 auto;
		margin-bottom: 0;
	}

	.install .version-field {
		max-width: 40rem;
	}

	.detail-buttons {
		display: flex;
		flex-direction: row;
		gap: var(--space-2);
		margin-bottom: 0.35rem;
	}

	.detail-buttons button {
		font-size: 0.82rem;
		white-space: nowrap;
	}

	.label-text {
		display: block;
		font-size: 0.85rem;
		color: var(--text-muted);
		margin-bottom: var(--space-2);
	}

	.loader-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
		gap: var(--space-2);
	}

	.loader-option {
		display: flex;
		gap: var(--space-2);
		align-items: flex-start;
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
		padding: var(--space-3);
		cursor: pointer;
		color: var(--text);
		margin: 0;
		font-size: 0.9rem;
	}

	.loader-option.selected {
		border-color: var(--accent);
		background: var(--panel-raised);
	}

	.loader-option span span {
		display: block;
	}

	.loader-option input {
		margin-top: 0.25rem;
	}
</style>
