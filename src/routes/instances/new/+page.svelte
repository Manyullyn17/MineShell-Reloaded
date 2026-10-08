<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import { dropzone } from '#lib/shared/dropzone.js';
	import { untrack } from 'svelte';
	import Flash from '#lib/components/Flash.svelte';
	import JavaPrompt from '#lib/components/JavaPrompt.svelte';
	import DetailsDialog from '#lib/components/DetailsDialog.svelte';
	import FilterSidebar from '#lib/components/FilterSidebar.svelte';
	import CleanroomOption from '#lib/components/CleanroomOption.svelte';
	import PackModList from '#lib/components/PackModList.svelte';
	import SplitButton from '#lib/components/SplitButton.svelte';
	import { fitToViewport } from '#lib/shared/fitToViewport.js';
	import { CLEANMIX_WARNING, canUseCleanroom, usesCleanMix } from '#lib/shared/cleanroom.js';
	import { peekPack, type PackTarget } from '#lib/shared/packpeek.js';

	let { data, form } = $props();

	type Mode = 'browse' | 'upload' | 'loader';
	let mode = $state<Mode>('browse');
	/** 1 start from, 2 choose, 3 configure. Steps stay mounted, so going back keeps every field. */
	let step = $state(1);
	let showFilters = $state(false);
	let archiveName = $state('');
	/** What the picked file targets, read from its manifest; null until known or when unreadable. */
	let archiveTarget = $state<PackTarget | null>(null);

	async function pickArchive(file: File | undefined) {
		archiveName = file?.name ?? '';
		archiveTarget = null;
		if (!file) return;
		const target = await peekPack(file);
		// Another file may have been picked while this one was read.
		if (archiveName === file.name) archiveTarget = target;
	}
	const ACTIONS: Record<Mode, string> = { browse: '?/install', upload: '?/upload', loader: '?/loader' };
	const STARTS: { id: Mode; title: string; text: string }[] = [
		{ id: 'browse', title: 'Modpack', text: 'Search Modrinth, CurseForge or Feed the Beast and install a server version.' },
		{ id: 'upload', title: 'Upload a pack file', text: 'A CurseForge server zip or .mrpack you already have.' },
		{ id: 'loader', title: 'Mod loader', text: 'A bare Vanilla, Fabric, Quilt, Forge, NeoForge or Cleanroom server.' }
	];
	let submitting = $state(false);
	// Enhanced, so a refusal (a missing Java above all) keeps the picked pack,
	// the chosen file and every field instead of reloading the page.
	const submit = ({ cancel }: { cancel: () => void }) => {
		// Only Create on the last step installs. Every step is in this one form,
		// so any stray submit button (the detail pane's tabs were) would
		// otherwise install a pack the moment it was looked at.
		if (step !== 3) {
			cancel();
			return;
		}
		submitting = true;
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			submitting = false;
		};
	};

	// ---- shared fields
	let name = $state('');
	let nameTouched = $state(false);
	// Seeded from load data but user-editable afterwards, so it tracks a change
	// of suggestion without discarding an edit already in progress. The
	// effect right below keeps it in sync - this initial read is deliberate.
	// svelte-ignore state_referenced_locally
	let memoryMaxMb = $state(data.suggestedMaxMb);
	let memoryTouched = $state(false);
	$effect(() => {
		const suggested = data.suggestedMaxMb;
		if (!memoryTouched) memoryMaxMb = suggested;
	});
	// svelte-ignore state_referenced_locally
	let memoryMinMb = $state(data.defaultMinMb);

	// ---- loader-only mode
	// Seeded once, kept in sync by the effect below - deliberate initial read.
	// svelte-ignore state_referenced_locally
	let minecraftVersion = $state(data.minecraftVersions[0] ?? '');
	let versionTouched = $state(false);
	$effect(() => {
		const first = data.minecraftVersions[0] ?? '';
		if (!versionTouched && !minecraftVersion) minecraftVersion = first;
	});
	let modloader = $state('fabric');
	// Loaders tied to specific Minecraft versions (Cleanroom is 1.12.2 only)
	// narrow the picker, and selecting one snaps the version onto its list.
	let gameVersionChoices = $derived(
		data.loaders.find((l) => l.id === modloader)?.onlyGameVersions ?? data.minecraftVersions
	);
	$effect(() => {
		const choices = gameVersionChoices;
		if (choices.length && !choices.includes(minecraftVersion)) minecraftVersion = choices[0];
	});
	let loaderVersions = $state<string[]>([]);
	let modloaderVersion = $state('');
	let loaderVersionError = $state('');
	let loadingLoaderVersions = $state(false);

	$effect(() => {
		const mc = minecraftVersion;
		const loader = modloader;
		modloaderVersion = '';
		loaderVersions = [];
		loaderVersionError = '';
		loadingLoaderVersions = false;
		if (!mc || loader === 'vanilla') return;

		let cancelled = false;
		loadingLoaderVersions = true;
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
			})
			.finally(() => {
				if (!cancelled) loadingLoaderVersions = false;
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
	let searchPage = $state(1);
	let moreHits = $state(false);
	let loadingMore = $state(false);
	let lastQuery = '';
	let selected = $state<Hit | null>(null);

	// Switching source left the previous provider's results on screen, which
	// looked like the new source had returned them. Minecraft version isn't
	// source-specific, so that part of the selection survives the reset.
	// svelte-ignore state_referenced_locally
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
	// Cleanroom is offered only for Forge 1.12.2 pack versions.
	let cleanroomEligible = $derived.by(() => {
		const v = packVersions.find((p) => p.id === versionId);
		return !!v && v.gameVersions.some((mc) => v.loaders.some((l) => canUseCleanroom(l, mc)));
	});
	let javaMajors = $derived(data.javaRuntimes.map((j) => j.majorVersion));
	let loadingVersions = $state(false);
	/** Versions are listed in batches: a big project has hundreds. */
	const VERSION_BATCH = 50;
	let shownVersions = $state(VERSION_BATCH);

	// The picked version's mod list, for the install form.
	type Preview = { mods: { target: string; fileName: string; name: string; clientOnly: string | null; packDisabled: boolean; neededBy: string[] }[]; otherFiles: number };
	let preview = $state<Preview | null>(null);
	let previewLoading = $state(false);
	let previewError = $state('');
	$effect(() => {
		const id = selected?.id;
		const version = versionId;
		const from = source;
		preview = null;
		previewError = '';
		previewLoading = false;
		if (!id || !version) return;

		let cancelled = false;
		previewLoading = true;
		const params = new URLSearchParams({ source: from, id, versionId: version });
		fetch(`/api/packs/preview?${params}`)
			.then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => null))?.message ?? 'lookup failed'))))
			.then((body) => {
				if (!cancelled) preview = body.preview;
			})
			.catch((err) => {
				if (!cancelled) previewError = err instanceof Error ? err.message : 'lookup failed';
			})
			.finally(() => {
				if (!cancelled) previewLoading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	function searchQuery() {
		const params = new URLSearchParams({ source, term });
		for (const version of filterSelections.minecraftVersions ?? []) params.append('mc', version);
		for (const loader of filterSelections.loaders ?? []) params.append('loader', loader);
		for (const category of filterSelections.categories ?? []) {
			params.append('category', category);
		}
		return params;
	}

	async function search() {
		searching = true;
		searchError = '';
		selected = null;
		packVersions = [];
		searchPage = 1;
		try {
			lastQuery = searchQuery().toString();
			const res = await fetch(`/api/packs/search?${lastQuery}`);
			if (!res.ok) throw new Error((await res.json()).message ?? 'Search failed.');
			hits = (await res.json()).hits ?? [];
			moreHits = hits.length > 0;
			if (hits.length === 0) searchError = 'Nothing matched. Try different terms or fewer filters.';
		} catch (err) {
			searchError = err instanceof Error ? err.message : 'Search failed.';
			hits = [];
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
			const res = await fetch(`/api/packs/search?${params}`);
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
		if (!nameTouched) name = hit.name;
		loadingVersions = true;
		packVersions = [];
		shownVersions = VERSION_BATCH;
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

	const canContinue = $derived(
		step === 1 ||
			(mode === 'browse' && !!selected && !!versionId) ||
			(mode === 'upload' && !!archiveName) ||
			(mode === 'loader' && !!minecraftVersion)
	);
	const pickedVersion = $derived(packVersions.find((v) => v.id === versionId));
	const loaderLabel = $derived(data.loaders.find((l) => l.id === modloader)?.label ?? modloader);
	const downloads = (n: number | null) =>
		n === null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M downloads` : n >= 1e3 ? `${Math.round(n / 1e3)}k downloads` : `${n} downloads`;

	// Choosing a pack opens on popular ones rather than an empty list.
	$effect(() => {
		if (step === 2 && mode === 'browse' && !hits.length && !untrack(() => searching || searchError)) void untrack(search);
	});

	const sources = [
		{ id: 'modrinth', label: 'Modrinth' },
		{ id: 'curseforge', label: 'CurseForge' },
		{ id: 'ftb', label: 'Feed the Beast' }
	];
</script>

<svelte:head><title>Add a server - MineShell</title></svelte:head>

<header class="page-head">
	<div>
		<h1>Add a server</h1>
		<p class="muted">Installs in the background; you can leave the page once it starts. Watch progress under Activity.</p>
	</div>
	<ol class="steps" aria-label="Steps">
		{#each ['Start from', 'Choose', 'Configure'] as label, i (label)}
			{#if i}<li class="line" aria-hidden="true"></li>{/if}
			<li class:done={step > i + 1} class:current={step === i + 1}>
				<span class="num">{step > i + 1 ? '✓' : i + 1}</span>{label}
			</li>
		{/each}
	</ol>
</header>

<Flash {form} />

{#snippet memoryRows()}
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
{/snippet}

<!-- ============================================================ step 1 -->
<section class="step" hidden={step !== 1}>
	<h2>What do you want to start from?</h2>
	<div class="starts" role="radiogroup" aria-label="Start from">
		{#each STARTS as start (start.id)}
			<button
				type="button"
				class="start"
				role="radio"
				aria-checked={mode === start.id}
				onclick={() => (mode = start.id)}
				ondblclick={() => {
					mode = start.id;
					step = 2;
				}}
			>
				<span class="start-head"><strong>{start.title}</strong><span class="radio" aria-hidden="true"></span></span>
				<span class="small muted">{start.text}</span>
			</button>
		{/each}
	</div>
</section>

<form method="POST" action={ACTIONS[mode]} enctype="multipart/form-data" use:enhance={submit} class="new-form">
	<!-- ========================================================== step 2 -->
	<section class="step" hidden={step !== 2}>
		{#if mode === 'browse'}
			<input type="hidden" name="source" value={source} />
			<input type="hidden" name="projectId" value={selected?.id ?? ''} />
			<input type="hidden" name="versionId" value={versionId} />
			<div class="browse-bar">
				<div class="segmented" role="group" aria-label="Source">
					{#each sources as s (s.id)}
						<button type="button" aria-pressed={source === s.id} onclick={() => (source = s.id)}>{s.label}</button>
					{/each}
				</div>
				<span class="search">
					<span aria-hidden="true">⌕</span>
					<input
						type="search"
						placeholder="Search modpacks, or leave blank for popular ones"
						aria-label="Search modpacks"
						bind:value={term}
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								void search();
							}
						}}
					/>
				</span>
				<button type="button" onclick={search} disabled={searching}>{searching ? 'Searching' : 'Search'}</button>
				<button type="button" class="button-quiet" aria-expanded={showFilters} onclick={() => (showFilters = !showFilters)}>
					{showFilters ? 'Hide filters' : 'Filters'}
				</button>
			</div>

			{#if searchError}<p class="notice warning">{searchError}</p>{/if}

			<div class="browse" class:with-filters={showFilters}>
				{#if showFilters}
					<FilterSidebar groups={combinedFilterGroups} bind:selected={filterSelections} loading={loadingFilters} limitNote={filterLimitNote} />
				{/if}
				<!-- 104: the form's 5rem kept free for the bottom bar, plus the page's own padding. -->
				<ul class="hits" use:fitToViewport={{ bottomMarginPx: 104 }}>
					{#each hits as hit (hit.id)}
						<li>
							<button type="button" class="hit" aria-pressed={selected?.id === hit.id} onclick={() => choose(hit)}>
								{#if hit.iconUrl}
									<img src={hit.iconUrl} alt="" width="44" height="44" loading="lazy" />
								{:else}
									<span class="icon-fallback" aria-hidden="true"></span>
								{/if}
								<span class="hit-body">
									<span class="hit-title"><strong>{hit.name}</strong></span>
									{#if hit.loaders?.length || hit.gameVersions?.length}
										<span class="hit-meta">
											{#if hit.gameVersions?.length}<span class="tag">{summariseVersions(hit.gameVersions)}</span>{/if}
											{#each [...new Set(hit.loaders ?? [])].slice(0, 2) as loader (loader)}
												<span class="tag accent">{loader}</span>
											{/each}
										</span>
									{/if}
									<span class="small muted summary">{hit.summary ?? ''}</span>
									<span class="faint small">{[hit.author ? `by ${hit.author}` : '', downloads(hit.downloads)].filter(Boolean).join(' · ')}</span>
								</span>
							</button>
						</li>
					{:else}
						<li class="faint small hits-empty">{searching ? 'Searching.' : 'No packs to show yet.'}</li>
					{/each}
					{#if hits.length && moreHits}
						<li class="more-hits">
							<button type="button" class="button-quiet" onclick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading' : 'Load more'}</button>
						</li>
					{/if}
				</ul>

				{#if selected}
					<div class="detail" use:fitToViewport={{ bottomMarginPx: 104 }}>
						<DetailsDialog
							inline
							{source}
							kind="modpack"
							projectId={selected.id}
							{versionId}
							versionLabel={pickedVersion?.versionNumber ?? ''}
							iconUrl={selected.iconUrl}
							meta={downloads(selected.downloads)}
							versionCount={loadingVersions ? null : packVersions.length}
						>
							{#snippet versionsTab({ showChangelog }: { showChangelog: () => void })}
								{#if loadingVersions}
									<p class="muted">Loading versions.</p>
								{:else if packVersions.length === 0}
									<p class="muted">No versions were returned for this pack.</p>
								{:else}
									<ul class="version-list plain">
										{#each packVersions.slice(0, shownVersions) as v (v.id)}
											<li>
												<label class="version" class:picked={versionId === v.id}>
													<input type="radio" value={v.id} bind:group={versionId} />
													<span class="version-name">
														<span class="mono">{v.versionNumber}</span>
														{#if v.gameVersions.length}<span class="faint small">MC {v.gameVersions.join(', ')}</span>{/if}
														{#if v.channel !== 'release'}<span class="tag warn">{v.channel}</span>{/if}
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
									{#if packVersions.length > shownVersions}
										<button type="button" class="button-quiet show-more" onclick={() => (shownVersions += VERSION_BATCH)}>
											{packVersions.length - shownVersions > VERSION_BATCH ? `Show ${VERSION_BATCH} more (${packVersions.length - shownVersions} left)` : `Show the other ${packVersions.length - shownVersions}`}
										</button>
									{/if}
								{/if}
							{/snippet}
							{#snippet footer()}
								<div class="pick-row">
									<span class="small">
										{#if pickedVersion}
											Selected <span class="mono">{pickedVersion.versionNumber}</span>
											<span class="faint">
												{[pickedVersion.gameVersions.join(', '), [...new Set(pickedVersion.loaders)].join(', ')].filter(Boolean).join(' · ')}
											</span>
										{:else}
											{loadingVersions ? 'Loading versions.' : 'No version picked.'}
										{/if}
									</span>
									<button type="button" class="button-primary" disabled={!versionId} onclick={() => (step = 3)}>Use this version</button>
								</div>
							{/snippet}
						</DetailsDialog>
					</div>
				{:else}
					<div class="detail empty"><p>Pick a pack to see its description, versions and changelog.</p></div>
				{/if}
			</div>
		{:else if mode === 'upload'}
			<h2>Pack file</h2>
			<p class="muted">
				MineShell reads Modrinth <code>.mrpack</code> files and CurseForge server pack zips. Use this when a pack is not
				listed, or for a custom export.
			</p>
			<label class="drop" use:dropzone={{ label: 'Drop the .mrpack or .zip here' }}>
				<input
					name="archive"
					type="file"
					accept=".mrpack,.zip"
					class="visually-hidden"
					onchange={(e) => pickArchive((e.currentTarget as HTMLInputElement).files?.[0])}
				/>
				<strong>{archiveName || 'Choose a .mrpack or .zip'}</strong>
				<span class="small muted">{archiveName ? 'Click to pick another' : 'Click to browse'}</span>
			</label>
		{:else}
			<h2>Mod loader</h2>
			<div class="loader-grid" role="radiogroup" aria-label="Mod loader">
				{#each data.loaders as loader (loader.id)}
					<label class="loader-option" class:selected={modloader === loader.id}>
						<input type="radio" name="modloader" value={loader.id} bind:group={modloader} />
						<strong>{loader.label}</strong>
						<span class="small muted">{loader.blurb}</span>
					</label>
				{/each}
			</div>
			<div class="grid-2 versions-row">
				<div class="field">
					<label for="minecraftVersion">Minecraft version</label>
					{#if gameVersionChoices.length}
						<select id="minecraftVersion" name="minecraftVersion" bind:value={minecraftVersion} onchange={() => (versionTouched = true)} required>
							{#each gameVersionChoices as version (version)}
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
						{#if loadingLoaderVersions || loaderVersions.length}
							<select id="modloaderVersion" name="modloaderVersion" bind:value={modloaderVersion} disabled={loadingLoaderVersions}>
								{#if loadingLoaderVersions}
									<option value="">Loading.</option>
								{:else}
									<option value="">Latest ({loaderVersions[0]})</option>
									{#each loaderVersions.slice(0, 40) as version (version)}
										<option value={version}>{version}</option>
									{/each}
								{/if}
							</select>
						{:else}
							<input id="modloaderVersion" name="modloaderVersion" bind:value={modloaderVersion} placeholder="Leave blank for the latest" />
						{/if}
						{#if loaderVersionError}<p class="hint">{loaderVersionError}</p>{/if}
						{#if modloader === 'cleanroom' && !loadingLoaderVersions && usesCleanMix(modloaderVersion || null)}
							<p class="hint warn-text">{CLEANMIX_WARNING}</p>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	</section>

	<!-- ========================================================== step 3 -->
	<section class="step configure" hidden={step !== 3}>
		<div class="picked-pack">
			{#if mode === 'browse' && selected?.iconUrl}
				<img src={selected.iconUrl} alt="" width="40" height="40" />
			{:else}
				<span class="icon-fallback" aria-hidden="true"></span>
			{/if}
			<div class="grow">
				{#if mode === 'browse'}
					<strong>{selected?.name ?? ''} {pickedVersion?.versionNumber ?? ''}</strong>
					<div class="faint small">
						{[pickedVersion?.gameVersions.join(', '), [...new Set(pickedVersion?.loaders ?? [])].join(', ')].filter(Boolean).join(' · ')}
					</div>
				{:else if mode === 'upload'}
					<strong class="mono">{archiveName}</strong>
					<div class="faint small">Uploaded when you create the server</div>
				{:else}
					<strong>{loaderLabel} {minecraftVersion}</strong>
					<div class="faint small">
						{modloader === 'vanilla' ? 'Vanilla server' : `Loader ${modloaderVersion || 'latest'}; add mods yourself afterwards`}
					</div>
				{/if}
			</div>
			<button type="button" class="button-quiet" onclick={() => (step = 2)}>Change</button>
		</div>

		<div class="rows">
			<div class="field">
				<label for="server-name">Server name</label>
				<input
					id="server-name"
					name="name"
					bind:value={name}
					oninput={() => (nameTouched = true)}
					required={mode === 'loader'}
					placeholder={mode === 'loader' ? 'Survival world' : 'Taken from the pack if left blank'}
				/>
				<p class="hint">The folder is named after it and cannot change later.</p>
			</div>
			<div class="field">
				<label for="serverPort">Game port</label>
				<input id="serverPort" name="serverPort" type="number" min="1" max="65535" placeholder={String(data.nextPort)} />
				<p class="hint">
					Blank takes the next free one, {data.nextPort}.{data.usedPorts.length
						? ` ${data.usedPorts.join(', ')} ${data.usedPorts.length === 1 ? 'is' : 'are'} taken by your other servers.`
						: ''}
				</p>
			</div>
			{@render memoryRows()}
			{#if mode === 'loader' && data.javaRuntimes.length > 1}
				<div class="field">
					<label for="javaPath">Java</label>
					<select id="javaPath" name="javaPath">
						<option value="">Match automatically</option>
						{#each data.javaRuntimes as java (java.path)}
							<option value={java.path}>Java {java.majorVersion} - {java.path}</option>
						{/each}
					</select>
					<p class="hint">Matched to Minecraft {minecraftVersion} unless you pick one.</p>
				</div>
			{/if}
		</div>

		{#if mode === 'browse'}
			<div class="extra"><PackModList {preview} loading={previewLoading} error={previewError} /></div>
			{#if cleanroomEligible}
				<div class="extra"><CleanroomOption {javaMajors} idPrefix="pack-cleanroom" /></div>
			{/if}
		{:else if mode === 'upload'}
			{#if archiveTarget && canUseCleanroom(archiveTarget.loader ?? '', archiveTarget.minecraft ?? '')}
				<div class="extra"><CleanroomOption {javaMajors} idPrefix="upload-cleanroom" /></div>
			{/if}
		{/if}

		<label class="eula">
			<input type="checkbox" name="acceptEula" />
			<span>
				<strong>I agree to the <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Minecraft EULA</a></strong>
				<span class="small muted">Writes eula=true once installed, so the server can start. "Create &amp; start" accepts it too; you can also accept later.</span>
			</span>
		</label>

		<JavaPrompt {form} action={mode === 'browse' ? 'install' : mode} />
		<p class="faint small">
			Ports are picked automatically. Game settings, restarts and JVM flags come from
			<a href="/settings/defaults">New server defaults</a>; change them afterwards in the server's Settings.
		</p>
	</section>

	<div class="bottombar">
		{#if step > 1}
			<button type="button" class="button-quiet" onclick={() => (step -= 1)}>Back</button>
		{:else}
			<span></span>
		{/if}
		{#if step < 3}
			<button type="button" class="button-primary" disabled={!canContinue} onclick={() => (step += 1)}>Continue</button>
		{:else}
			<SplitButton
				label="Create server"
				busyLabel={mode === 'upload' ? 'Uploading' : 'Creating'}
				busy={submitting}
				disabled={mode === 'browse' ? !versionId : mode === 'upload' ? !archiveName : !minecraftVersion}
				altLabel="Create & start"
				altNote="Starts it once installed, accepting the Minecraft EULA"
			/>
		{/if}
	</div>
</form>

<style>
	.warn-text {
		color: var(--warning);
	}

	.page-head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--space-4);
		flex-wrap: wrap;
		margin: 0 -2.5rem 1.5rem;
		padding: 0.3rem 2.5rem 1.4rem;
		border-bottom: 1px solid var(--line);
	}

	.page-head p {
		margin: 0.3rem 0 0;
	}

	.steps {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: 0.93rem;
		color: var(--text-muted);
	}

	.steps li {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		white-space: nowrap;
	}

	.steps .line {
		width: 1.6rem;
		height: 1px;
		background: var(--line-strong);
	}

	.steps .num {
		display: grid;
		place-items: center;
		width: 1.35rem;
		height: 1.35rem;
		border-radius: 3px;
		font-size: 0.75rem;
		font-family: var(--font-mono);
		background: var(--panel-raised);
	}

	.steps .current {
		color: var(--text);
	}

	.steps .current .num,
	.steps .done .num {
		background: var(--accent);
		color: var(--accent-contrast);
	}

	.step[hidden] {
		display: none;
	}

	.step h2 {
		font-size: 1.05rem;
		margin-bottom: var(--space-4);
	}

	.starts {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 18rem));
		gap: var(--space-3);
	}

	.start,
	.loader-option {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		justify-content: flex-start;
		gap: 0.35rem;
		padding: 1rem 1.1rem;
		text-align: left;
		white-space: normal;
		font-weight: 400;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		cursor: pointer;
	}

	.start[aria-checked='true'],
	.loader-option.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 6%, var(--panel));
	}

	.start-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 1rem;
	}

	.radio {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 2px solid var(--line-strong);
	}

	.start[aria-checked='true'] .radio {
		border-color: var(--accent);
		background: radial-gradient(circle, var(--accent) 3.5px, transparent 4px);
	}

	.loader-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
		gap: var(--space-2);
		max-width: 60rem;
		margin-bottom: var(--space-4);
	}

	.loader-option {
		margin: 0;
		color: var(--text);
		padding: 0.8rem 0.9rem;
	}

	.loader-option input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.versions-row {
		max-width: 60rem;
	}

	/* ---- choosing a pack */

	.browse-bar {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-bottom: var(--space-4);
		flex-wrap: wrap;
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
		padding: 0.3rem 0.75rem;
		font-size: 0.88rem;
		font-weight: 400;
		background: transparent;
		color: var(--text-muted);
	}

	.segmented button[aria-pressed='true'] {
		background: var(--line-strong);
		color: var(--text);
	}

	.search {
		flex: 1 1 16rem;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		background: var(--bg-sunken);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
		padding: 0 0.6rem;
		color: var(--text-faint);
	}

	.search input {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: 0;
		padding: 0.45rem 0;
		outline: none;
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
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		overflow-y: auto;
		min-height: 16rem;
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
		width: 44px;
		height: 44px;
		flex: 0 0 44px;
		border-radius: var(--radius);
		background: var(--panel-raised);
		object-fit: cover;
	}

	.hit-body {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}

	.hit-title strong {
		font-weight: 500;
	}

	.hit-meta {
		display: flex;
		gap: var(--space-1);
		flex-wrap: wrap;
	}

	.summary {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.detail {
		display: flex;
		flex-direction: column;
		min-height: 20rem;
	}

	.detail > :global(.pane) {
		flex: 1;
	}

	.detail.empty {
		display: grid;
		place-items: center;
	}

	.show-more {
		width: 100%;
		margin-top: var(--space-2);
	}

	.version-list {
		list-style: none;
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
		flex-wrap: wrap;
	}

	.pick-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.drop {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.3rem;
		max-width: 40rem;
		padding: 2.5rem;
		border: 1px dashed var(--line-strong);
		border-radius: var(--radius-lg);
		background: var(--panel);
		color: var(--text);
		cursor: pointer;
	}

	.drop:hover {
		border-color: var(--accent);
	}

	/* ---- configure */

	.configure {
		max-width: 56rem;
	}

	.picked-pack {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		padding: var(--space-4);
		margin-bottom: var(--space-3);
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
	}

	.picked-pack img {
		border-radius: var(--radius);
	}

	.picked-pack .icon-fallback {
		width: 40px;
		height: 40px;
		flex-basis: 40px;
	}

	.grow {
		flex: 1;
		min-width: 0;
	}

	.rows .field {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(9rem, 20rem);
		column-gap: 2rem;
		row-gap: 0.2rem;
		align-items: center;
		margin: 0;
		padding: 0.85rem 0;
		border-bottom: 1px solid var(--panel-raised);
	}

	.rows .field > label {
		grid-column: 1;
		margin: 0;
		font-size: 0.95rem;
		font-weight: 500;
		color: var(--text);
	}

	.rows .field > input,
	.rows .field > select {
		grid-column: 2;
		grid-row: 1 / span 2;
	}

	.rows .field > input[type='number'] {
		max-width: 8rem;
		justify-self: end;
		text-align: right;
	}

	.rows .field > .hint {
		grid-column: 1;
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.extra {
		margin-top: var(--space-4);
	}

	.eula {
		display: flex;
		align-items: flex-start;
		gap: 0.8rem;
		margin: var(--space-4) 0;
		padding: var(--space-4);
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		color: var(--text);
		font-size: 0.95rem;
		cursor: pointer;
	}

	.eula input {
		margin-top: 0.2rem;
	}

	.eula > span {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	/* Pinned to the window's bottom edge whatever the step's height, beside the rail. */
	.new-form {
		padding-bottom: 5rem;
	}

	.bottombar {
		position: fixed;
		bottom: 0;
		left: var(--rail-width);
		right: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		padding: 0.75rem 2.5rem;
		border-top: 1px solid var(--line);
		background: var(--bg);
	}

	@media (max-width: 70rem) {
		.browse,
		.browse.with-filters {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	@media (max-width: 60rem) {
		.starts {
			grid-template-columns: minmax(0, 1fr);
		}

		.steps .line {
			width: 0.8rem;
		}

		.page-head {
			margin: 0 calc(var(--space-4) * -1) 1.5rem;
			padding: 0.3rem var(--space-4) 1.4rem;
		}

		.bottombar {
			left: 0;
			padding: 0.75rem var(--space-4);
		}

		.rows .field {
			grid-template-columns: minmax(0, 1fr);
		}

		.rows .field > input,
		.rows .field > select {
			grid-column: 1;
			grid-row: auto;
		}
	}
</style>
