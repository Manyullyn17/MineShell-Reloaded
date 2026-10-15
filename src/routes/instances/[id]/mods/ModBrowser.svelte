<script lang="ts" module>
	export const SOURCES = [
		{ id: 'modrinth', label: 'Modrinth' },
		{ id: 'curseforge', label: 'CurseForge' }
	];
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '#lib/shared/forms.js';
	import { fitToViewport } from '#lib/shared/fitToViewport.js';
	import DetailsDialog from '#lib/components/DetailsDialog.svelte';
	import FilterSidebar from '#lib/components/FilterSidebar.svelte';
	import type { PageData } from './$types';

	/**
	 * The Add mods sub-tab: browse or search Modrinth and CurseForge, pick a
	 * version and its dependencies, install. The search box is in the page's
	 * tool row (`term`, `search()`). Stays mounted while another sub-tab is
	 * open (`active` false), so results and the picked mod are kept.
	 */
	let {
		active,
		instanceId,
		modloader,
		modloaderLabel,
		minecraftVersion,
		catalogLoader,
		compatibleLoaders,
		mods,
		datapackWorld,
		source = $bindable('modrinth'),
		term = $bindable(''),
		searching = $bindable(false)
	}: {
		active: boolean;
		instanceId: string;
		modloader: string;
		modloaderLabel: string;
		minecraftVersion: string;
		/** The loader the catalogs know this server's as (Cleanroom: forge). */
		catalogLoader: string;
		compatibleLoaders: string[];
		/** What is installed, to mark hits. */
		mods: PageData['mods'];
		/** The world folder data packs go into. */
		datapackWorld: string;
		source?: string;
		term?: string;
		searching?: boolean;
	} = $props();

	let showFilters = $state(false);
	let searchError = $state('');
	type Hit = {
		id: string;
		slug: string;
		name: string;
		author: string | null;
		summary: string | null;
		iconUrl: string | null;
		downloads: number | null;
		clientOnly?: boolean;
	};
	let hits = $state<Hit[]>([]);
	let searchPage = $state(1);
	let moreHits = $state(false);
	let loadingMore = $state(false);
	let lastQuery = '';
	let selected = $state<Hit | null>(null);
	type Version = {
		id: string;
		versionNumber: string;
		channel: string;
		clientOnly: boolean;
		/** Installs into the world's datapacks folder rather than mods/. */
		datapack: boolean;
		dependencies: { type: string; name: string | null }[];
	};
	let versions = $state<Version[]>([]);
	let versionId = $state('');
	let loadingVersions = $state(false);
	/** Versions are listed in batches: a big project has hundreds. */
	const VERSION_BATCH = 50;
	let shownVersions = $state(VERSION_BATCH);
	let detailsTab = $state<'description' | 'versions' | 'changelog'>('description');

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

	const isInstalled = (hit: { slug: string; id: string }) =>
		mods.some((m) => m.source === source && (m.slug === hit.slug || m.slug === hit.id));
	const downloads = (n: number | null) =>
		n === null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M downloads` : n >= 1e3 ? `${Math.round(n / 1e3)}k downloads` : `${n} downloads`;

	// ---- filter sidebar
	type FilterGroupData = { id: string; label: string; options: { value: string; label: string }[] };
	let filterGroups = $state<FilterGroupData[]>([]);
	let loadingFilters = $state(true);
	// The $effect below keeps this in sync on instance switches - deliberate initial read.
	// svelte-ignore state_referenced_locally
	let filterSelections = $state<Record<string, string[]>>({
		loaders: [...compatibleLoaders]
	});

	// This page persists across `/instances/[id]/mods` navigations (same
	// route, different `id`), so a plain one-time seed above would leave the
	// previous instance's mod-loader default checked after switching to a
	// server on a different loader. `modloader` only changes when the
	// instance actually does, unlike `compatibleLoaders`'s array
	// identity, which would also flip on an incidental revalidation and
	// wipe out filters the user picked by hand.
	// svelte-ignore state_referenced_locally
	let lastModloader = modloader;
	$effect(() => {
		if (modloader !== lastModloader) {
			lastModloader = modloader;
			filterSelections = { loaders: [...compatibleLoaders] };
		}
	});

	// Results, the picked mod and categories belong to one source; the loader
	// selection means the same thing on both and is kept. Emptying the
	// results makes the browser below open on the new source's popular mods.
	// svelte-ignore state_referenced_locally
	let lastSource = source;
	$effect(() => {
		const current = source;
		if (current !== lastSource) {
			lastSource = current;
			hits = [];
			selected = null;
			versions = [];
			versionId = '';
			searchError = '';
			filterSelections = { loaders: filterSelections.loaders ?? [] };
		}
	});

	$effect(() => {
		const currentSource = source;
		loadingFilters = true;
		let cancelled = false;
		fetch(`/api/mods/filters?source=${currentSource}&kind=mod`)
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

	// CurseForge browsing takes one loader and one category per request.
	const filterLimitNote = $derived(
		source === 'curseforge'
			? 'Browsing without a search term only applies the first checked loader and category. Searching by name applies every one.'
			: ''
	);

	function searchQuery() {
		const params = new URLSearchParams({ source, term, mc: minecraftVersion });
		for (const loader of filterSelections.loaders ?? []) params.append('loader', loader);
		for (const category of filterSelections.categories ?? []) {
			params.append('category', category);
		}
		for (const type of filterSelections.projectTypes ?? []) params.append('type', type);
		return params;
	}

	// Opening Add mods shows popular mods rather than an empty list, as the modpack browser does.
	$effect(() => {
		if (active && !hits.length && !untrack(() => searching || searchError)) void untrack(search);
	});

	export async function search() {
		searching = true;
		searchError = '';
		selected = null;
		searchPage = 1;
		try {
			lastQuery = searchQuery().toString();
			const res = await fetch(`/api/mods/search?${lastQuery}`);
			if (!res.ok) throw new Error('Search failed.');
			hits = (await res.json()).hits ?? [];
			moreHits = hits.length > 0;
			if (!hits.length) searchError = 'Nothing matched. Try different terms or fewer filters.';
		} catch (err) {
			searchError = err instanceof Error ? err.message : 'Search failed.';
		} finally {
			searching = false;
		}
	}

	/** The next page of the same search, added below; stops offering more once a page brings nothing new. */
	async function loadMore() {
		loadingMore = true;
		try {
			// The search as it ran, not as the boxes read now.
			const params = new URLSearchParams(lastQuery);
			params.set('page', String(searchPage + 1));
			const res = await fetch(`/api/mods/search?${params}`);
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Could not load more.');
			const known = new Set(hits.map((h) => h.id));
			const fresh = ((await res.json()).hits ?? []).filter((h: Hit) => !known.has(h.id));
			searchPage += 1;
			hits = [...hits, ...fresh];
			moreHits = fresh.length > 0;
		} catch (err) {
			searchError = err instanceof Error ? err.message : 'Could not load more.';
		} finally {
			loadingMore = false;
		}
	}

	async function choose(hit: Hit) {
		selected = hit;
		versions = [];
		shownVersions = VERSION_BATCH;
		versionId = '';
		loadingVersions = true;
		const params = new URLSearchParams({
			source,
			id: hit.id,
			mc: minecraftVersion,
			loader: catalogLoader
		});
		try {
			const res = await fetch(`/api/mods/versions?${params}`);
			if (res.ok) {
				versions = (await res.json()).versions ?? [];
				versionId = versions[0]?.id ?? '';
			}
		} finally {
			loadingVersions = false;
		}
	}

	// Resolve the picked version's dependencies to real names so each one can be
	// listed and ticked individually, rather than hidden behind one blanket
	// "install dependencies" checkbox.
	$effect(() => {
		const project = selected?.id;
		const version = versionId;
		const currentSource = source;
		dependencies = [];
		chosenDeps = {};
		if (!project || !version) return;

		let cancelled = false;
		loadingDeps = true;
		const params = new URLSearchParams({
			source: currentSource,
			id: project,
			versionId: version,
			mc: minecraftVersion,
			loader: catalogLoader,
			instance: instanceId
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

{#if active}
	<div class="browse-bar">
		<div class="segmented" role="group" aria-label="Source">
			{#each SOURCES as s (s.id)}
				<button type="button" aria-pressed={source === s.id} onclick={() => (source = s.id)}>{s.label}</button>
			{/each}
		</div>
		<span class="faint small">
			Showing mods for {modloaderLabel} {minecraftVersion}. Leave the search blank to browse popular ones.
		</span>
		<button type="button" class="button-quiet filters-toggle" aria-expanded={showFilters} onclick={() => (showFilters = !showFilters)}>
			{showFilters ? 'Hide filters' : 'Filters'}
		</button>
	</div>

	{#if searchError}<p class="notice warning">{searchError}</p>{/if}

	<div class="browse" class:with-filters={showFilters}>
		{#if showFilters}
			<FilterSidebar groups={filterGroups} bind:selected={filterSelections} loading={loadingFilters} limitNote={filterLimitNote} />
		{/if}

		<ul class="hits" use:fitToViewport={{ bottomMarginPx: 24 }}>
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
								<span class="faint small">{downloads(hit.downloads)}</span>
							</span>
							<span class="small muted summary">{hit.summary ?? ''}</span>
							{#if isInstalled(hit) || hit.clientOnly}
								<span class="hit-tags">
									{#if isInstalled(hit)}<span class="tag accent">installed</span>{/if}
									{#if hit.clientOnly}<span class="tag warn">client-only</span>{/if}
								</span>
							{/if}
						</span>
					</button>
				</li>
			{:else}
				<li class="faint small hits-empty">
					{searching ? 'Searching.' : 'No mods to show yet.'}
				</li>
			{/each}
			{#if hits.length && moreHits}
				<li class="more-hits">
					<button type="button" class="button-quiet" onclick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading' : 'Load more'}</button>
				</li>
			{/if}
		</ul>

		{#if selected}
			{@const pick = versions.find((v) => v.id === versionId)}
			<div class="detail" use:fitToViewport={{ bottomMarginPx: 24 }}>
				<DetailsDialog
					inline
					{source}
					projectId={selected.id}
					{versionId}
					versionLabel={pick?.versionNumber ?? ''}
					defaultTab={detailsTab}
					iconUrl={selected.iconUrl}
					meta={downloads(selected.downloads)}
					versionCount={loadingVersions ? null : versions.length}
				>
					{#snippet versionsTab({ showChangelog }: { showChangelog: () => void })}
						{#if loadingVersions}
							<p class="muted">Loading versions.</p>
						{:else if versions.length === 0}
							<p class="muted">No versions were returned for this mod.</p>
						{:else}
							<ul class="version-list plain">
								{#each versions.slice(0, shownVersions) as v (v.id)}
									<li>
										<label class="version" class:picked={versionId === v.id}>
											<input type="radio" name="version-pick" value={v.id} bind:group={versionId} />
											<span class="version-name">
												<span class="mono">{v.versionNumber}</span>
												{#if v.channel !== 'release'}<span class="tag warn">{v.channel}</span>{/if}
												{#if v.clientOnly}<span class="tag warn">client-only</span>{/if}
												{#if v.datapack}<span class="tag">data pack</span>{/if}
											</span>
											<button
												type="button"
												class="button-quiet small"
												onclick={() => {
													versionId = v.id;
													showChangelog();
												}}>Changelog</button
											>
										</label>
									</li>
								{/each}
							</ul>
							{#if versions.length > shownVersions}
								<button type="button" class="button-quiet show-more" onclick={() => (shownVersions += VERSION_BATCH)}>
									{versions.length - shownVersions > VERSION_BATCH ? `Show ${VERSION_BATCH} more (${versions.length - shownVersions} left)` : `Show the other ${versions.length - shownVersions}`}
								</button>
							{/if}
						{/if}
					{/snippet}
					{#snippet footer()}
						<form
							method="POST"
							action="?/install"
							class="install"
							use:enhance={() => {
								return async ({ result, update }) => {
									await update();
									// A finished install leaves the browser on the list, not on the mod just added.
									if (result.type === 'success') {
										selected = null;
										versions = [];
										versionId = '';
									}
								};
							}}
						>
							<input type="hidden" name="source" value={source} />
							<input type="hidden" name="projectId" value={selected?.id ?? ''} />
							<input type="hidden" name="versionId" value={versionId} />

							{#if pick?.datapack}
								<p class="notice info small">
									A data pack: it goes into <code>{datapackWorld}/datapacks</code>, not the mods folder. Packs that
									change world generation only affect chunks generated after it is installed.
								</p>
							{/if}
							{#if pick?.clientOnly}
								<p class="notice warning small">
									This build is marked client-only: it does nothing on a server, and some crash one. Install it only if a
									server mod needs it.
								</p>
							{/if}

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
												<input type="hidden" name="dependency" value="{dep.projectId}:{dep.versionId}" />
											{/if}
											<label for="dep-{dep.projectId}">
												<span class="dep-name">
													{dep.name}
													<span class="tag" class:warn={dep.type === 'required'}>{dep.type}</span>
													{#if dep.alreadyInstalled}<span class="tag ok">installed</span>{/if}
												</span>
												{#if dep.alreadyInstalled}
													<span class="small muted">Already in this instance.</span>
												{:else if !dep.installable}
													<span class="small warn-text">
														No build for {catalogLoader}
														{minecraftVersion}. Install it by hand if the mod needs it.
													</span>
												{/if}
											</label>
										</div>
									{/each}
								</fieldset>
							{/if}

							<div class="install-row">
								<span class="small">
									{#if pick}
										Selected <span class="mono">{pick.versionNumber}</span>
										{#if pick.channel !== 'release'}<span class="tag warn">{pick.channel}</span>{/if}
									{:else if loadingVersions}
										Loading versions.
									{:else}
										No version to install.
									{/if}
								</span>
								<button class="button-primary" type="submit" disabled={!versionId}>Install</button>
							</div>
						</form>
					{/snippet}
				</DetailsDialog>
			</div>
		{:else}
			<div class="detail placeholder empty">
				<p>Pick a mod to see its description, versions and changelog.</p>
			</div>
		{/if}
	</div>
{/if}

<style>
	.warn-text {
		color: var(--warning);
	}

	.tag.ok {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 45%, var(--line-strong));
	}

	.browse-bar {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin-bottom: var(--space-4);
		flex-wrap: wrap;
	}

	.filters-toggle {
		margin-left: auto;
	}

	.segmented {
		display: flex;
		gap: 2px;
		padding: 2px;
		background: var(--bg-sunken);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
	}

	.segmented button {
		border: 0;
		padding: 0.25rem 0.75rem;
		font-size: 0.88rem;
		font-weight: 400;
		background: transparent;
		color: var(--text-muted);
	}

	.segmented button[aria-pressed='true'] {
		background: var(--line-strong);
		color: var(--text);
	}

	.browse {
		display: grid;
		grid-template-columns: minmax(16rem, 22rem) minmax(0, 1fr);
		gap: 1.25rem;
		align-items: start;
	}

	.browse.with-filters {
		grid-template-columns: 12rem minmax(16rem, 22rem) minmax(0, 1fr);
	}

	.hits {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		min-height: 16rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.more-hits button {
		width: 100%;
	}

	.hits-empty {
		padding: var(--space-3);
	}

	.hit {
		display: flex;
		justify-content: flex-start;
		align-items: flex-start;
		gap: 0.9rem;
		width: 100%;
		text-align: left;
		padding: 0.9rem var(--space-4);
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		font-weight: 400;
		white-space: normal;
	}

	.hit:hover:not(:disabled) {
		border-color: var(--line-strong);
	}

	.hit[aria-pressed='true'] {
		border-color: var(--accent);
	}

	.hit img,
	.icon-fallback {
		width: 40px;
		height: 40px;
		flex: 0 0 40px;
		border-radius: var(--radius);
		background: var(--panel-raised);
		object-fit: cover;
	}

	.hit-body {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		flex: 1;
	}

	.hit-title {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.hit-title strong {
		font-weight: 500;
	}

	.summary {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.hit-tags {
		display: flex;
		gap: var(--space-1);
		margin-top: 0.2rem;
	}

	.detail {
		display: flex;
		flex-direction: column;
		min-height: 20rem;
	}

	.detail > :global(.pane) {
		flex: 1;
	}

	.detail.placeholder {
		display: grid;
		place-items: center;
	}

	.show-more {
		width: 100%;
		margin-top: var(--space-2);
	}

	.version-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.version {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin: 0;
		padding: 0.45rem 0.6rem;
		border-radius: var(--radius);
		color: var(--text);
		cursor: pointer;
	}

	.version.picked {
		background: var(--panel-raised);
	}

	.version-name {
		flex: 1;
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.install-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.install .notice {
		margin-bottom: var(--space-2);
	}

	.deps {
		margin: 0 0 var(--space-3);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
		max-height: 12rem;
		overflow-y: auto;
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

	@media (max-width: 70rem) {
		.browse,
		.browse.with-filters {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
