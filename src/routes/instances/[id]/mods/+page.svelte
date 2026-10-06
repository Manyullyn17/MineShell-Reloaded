<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import Flash from '#lib/components/Flash.svelte';
	import DetailsDialog from '#lib/components/DetailsDialog.svelte';
	import FilterSidebar from '#lib/components/FilterSidebar.svelte';
	import SnapshotChoice from '#lib/components/SnapshotChoice.svelte';
	import InfoTip from '#lib/components/InfoTip.svelte';
	import { fitToViewport } from '#lib/shared/fitToViewport.js';
	import { formatBytes } from '#lib/shared/format.js';

	let { data, form } = $props();

	let filter = $state('');
	/** Which sub-tab is open. */
	let view = $state<'installed' | 'updates' | 'browse' | 'datapacks'>('installed');
	let modFilter = $state<'all' | 'enabled' | 'disabled' | 'attention'>('all');
	let showFilters = $state(false);
	let uploadForm = $state<HTMLFormElement | null>(null);
	let pendingDelete = $state<string | null>(null);
	// A pack's first sync looks up every jar on CurseForge, which takes half a
	// minute on a big pack; without this the button looked like it did nothing.
	let syncing = $state(false);

	// ---- updates and version changes
	// A modpack's mods are usually changed through the pack's version; changing
	// single ones is opt-in each visit, and the server checks the same flag.
	let packMods = $state(false);
	const changesLocked = $derived(!!data.packName && !packMods);
	const canChange = (mod: { source: string; missing: boolean }) =>
		(mod.source === 'modrinth' || mod.source === 'curseforge') && !mod.missing;

	type UpdateCheck = {
		updates: { fileName: string; name: string; currentVersion: string | null; targetVersionId: string; targetVersion: string; channel: string; enabled: boolean; fromPack: boolean }[];
		upToDate: number;
		skipped: { fileName: string; name: string; reason: string }[];
		dependencies: DependencyPlan;
		synced: string | null;
	};
	type DependencyPlan = {
		install: { projectId: string; name: string; versionNumber: string; neededBy: string[] }[];
		unresolved: { name: string; neededBy: string[]; reason: string }[];
	};
	let updateCheck = $state<UpdateCheck | null>(null);
	let checking = $state(false);
	let checkError = $state('');
	let chosenUpdates = $state<Record<string, boolean>>({});
	const chosenCount = $derived(Object.values(chosenUpdates).filter(Boolean).length);

	async function checkUpdates() {
		checking = true;
		checkError = '';
		updateCheck = null;
		try {
			const res = await fetch(`/api/instances/${encodeURIComponent(data.instance.id)}/mod-updates`);
			const body = await res.json();
			if (!res.ok) throw new Error(body.message ?? 'Checking for updates failed.');
			updateCheck = body;
			chosenUpdates = Object.fromEntries(body.updates.map((u: { fileName: string }) => [u.fileName, true]));
		} catch (err) {
			checkError = err instanceof Error ? err.message : 'Checking for updates failed.';
		} finally {
			checking = false;
		}
	}

	type VersionChoice = { id: string; versionNumber: string; channel: string; datePublished: string | null; installed: boolean };
	let versionFor = $state<string | null>(null);
	let versionList = $state<VersionChoice[]>([]);
	let versionPick = $state('');
	let versionsLoading = $state(false);
	let versionError = $state('');

	async function openVersions(fileName: string) {
		if (versionFor === fileName) {
			versionFor = null;
			return;
		}
		versionFor = fileName;
		versionList = [];
		versionError = '';
		versionsLoading = true;
		try {
			const params = new URLSearchParams({ fileName });
			const res = await fetch(`/api/instances/${encodeURIComponent(data.instance.id)}/mod-versions?${params}`);
			const body = await res.json();
			if (!res.ok) throw new Error(body.message ?? 'Looking up versions failed.');
			versionList = body.versions;
			versionPick = body.versions.find((v: VersionChoice) => !v.installed)?.id ?? '';
			if (!versionList.length) versionError = 'No version of this mod runs on this server.';
		} catch (err) {
			versionError = err instanceof Error ? err.message : 'Looking up versions failed.';
		} finally {
			versionsLoading = false;
		}
	}

	// What the picked version would bring in; looked up whenever the pick changes.
	let versionDeps = $state<DependencyPlan | null>(null);
	let versionDepsLoading = $state(false);
	$effect(() => {
		const fileName = versionFor;
		const versionId = versionPick;
		versionDeps = null;
		if (!fileName || !versionId || versionList.find((v) => v.id === versionId)?.installed) return;
		let cancelled = false;
		versionDepsLoading = true;
		const params = new URLSearchParams({ fileName, versionId });
		fetch(`/api/instances/${encodeURIComponent(data.instance.id)}/mod-versions?${params}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => {
				if (!cancelled) versionDeps = body?.dependencies ?? null;
			})
			.catch(() => undefined)
			.finally(() => {
				if (!cancelled) versionDepsLoading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	function versionLabel(v: VersionChoice) {
		const date = v.datePublished ? new Date(v.datePublished).toLocaleDateString() : '';
		return `${v.versionNumber}${v.channel !== 'release' ? ` (${v.channel})` : ''}${date ? ` - ${date}` : ''}${v.installed ? ' (installed)' : ''}`;
	}
	const syncEnhance: SubmitFunction = () => {
		syncing = true;
		return async ({ update }) => {
			await update();
			syncing = false;
		};
	};
	let detailsTab = $state<'description' | 'versions' | 'changelog'>('description');

	/** Untracked jars, records without a file and enabled client-only mods ask to be looked at. */
	const needsAttention = (m: (typeof data.mods)[number]) => m.untracked || m.missing || (m.clientOnly && m.enabled);
	const filterCounts = $derived({
		all: data.mods.length,
		enabled: data.mods.filter((m) => m.enabled && !m.missing).length,
		disabled: data.mods.filter((m) => !m.enabled && !m.missing).length,
		attention: data.mods.filter(needsAttention).length
	});
	const visible = $derived(
		data.mods.filter(
			(m) =>
				m.name.toLowerCase().includes(filter.trim().toLowerCase()) &&
				(modFilter === 'all' ||
					(modFilter === 'enabled' && m.enabled && !m.missing) ||
					(modFilter === 'disabled' && !m.enabled && !m.missing) ||
					(modFilter === 'attention' && needsAttention(m)))
		)
	);
	const sourceLabel = (id: string) =>
		({ modrinth: 'Modrinth', curseforge: 'CurseForge', manual: 'Uploaded' })[id] ?? id;
	const isInstalled = (hit: { slug: string; id: string }) =>
		data.mods.some((m) => m.source === source && (m.slug === hit.slug || m.slug === hit.id));
	const downloads = (n: number | null) =>
		n === null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M downloads` : n >= 1e3 ? `${Math.round(n / 1e3)}k downloads` : `${n} downloads`;

	// ---- mod browser
	const sources = [
		{ id: 'modrinth', label: 'Modrinth' },
		{ id: 'curseforge', label: 'CurseForge' }
	];
	let source = $state('modrinth');
	let term = $state('');
	let searching = $state(false);
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

	// ---- filter sidebar
	type FilterGroupData = { id: string; label: string; options: { value: string; label: string }[] };
	let filterGroups = $state<FilterGroupData[]>([]);
	let loadingFilters = $state(true);
	// The $effect below keeps this in sync on instance switches - deliberate initial read.
	// svelte-ignore state_referenced_locally
	let filterSelections = $state<Record<string, string[]>>({
		loaders: [...data.compatibleLoaders]
	});

	// This page persists across `/instances/[id]/mods` navigations (same
	// route, different `id`), so a plain one-time seed above would leave the
	// previous instance's mod-loader default checked after switching to a
	// server on a different loader. `data.modloader` only changes when the
	// instance actually does, unlike `data.compatibleLoaders`'s array
	// identity, which would also flip on an incidental revalidation and
	// wipe out filters the user picked by hand.
	// svelte-ignore state_referenced_locally
	let lastModloader = data.modloader;
	$effect(() => {
		if (data.modloader !== lastModloader) {
			lastModloader = data.modloader;
			filterSelections = { loaders: [...data.compatibleLoaders] };
		}
	});

	// Results, the picked mod and categories belong to one source; the loader
	// selection means the same thing on both and is kept. Searching is left
	// to the user, as on first opening the browser.
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

	async function search() {
		searching = true;
		searchError = '';
		selected = null;
		try {
			const params = new URLSearchParams({ source, term, mc: data.minecraftVersion });
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
		loadingVersions = true;
		const params = new URLSearchParams({
			source,
			id: hit.id,
			mc: data.minecraftVersion,
			loader: data.catalogLoader
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
			mc: data.minecraftVersion,
			loader: data.catalogLoader,
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

{#snippet dependencyList(plan: DependencyPlan)}
	{#if plan.install.length}
		<p class="small">Also installs what the new versions need:</p>
		<ul class="small deps">
			{#each plan.install as d (d.projectId)}
				<li><strong>{d.name}</strong> <span class="mono">{d.versionNumber}</span> <span class="muted">- for {d.neededBy.join(', ')}</span></li>
			{/each}
		</ul>
	{/if}
	{#if plan.unresolved.length}
		<ul class="small deps warn-text">
			{#each plan.unresolved as d (d.name)}
				<li>{d.name}, needed by {d.neededBy.join(', ')}, cannot be installed: {d.reason}.</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<div class="subhead">
	<nav class="subtabs" aria-label="Mods sections">
		<button type="button" aria-current={view === 'installed' ? 'page' : undefined} onclick={() => (view = 'installed')}>
			Installed<span class="count">{data.counts.total}</span>
		</button>
		<button type="button" aria-current={view === 'updates' ? 'page' : undefined} onclick={() => (view = 'updates')}>
			Updates{#if updateCheck?.updates.length}<span class="badge">{updateCheck.updates.length}</span>{/if}
		</button>
		<button type="button" aria-current={view === 'browse' ? 'page' : undefined} onclick={() => (view = 'browse')}>
			Add mods
		</button>
		<button type="button" aria-current={view === 'datapacks' ? 'page' : undefined} onclick={() => (view = 'datapacks')}>
			Data packs<span class="count">{data.datapacks.packs.length}</span>
		</button>
	</nav>
	<div class="tools">
		{#if view === 'browse'}
			<span class="search">
				<span aria-hidden="true">⌕</span>
				<input
					type="search"
					bind:value={term}
					placeholder="Search {sources.find((s) => s.id === source)?.label}"
					aria-label="Search mods"
					onkeydown={(e) => e.key === 'Enter' && search()}
				/>
			</span>
			<button type="button" onclick={search} disabled={searching}>{searching ? 'Searching' : 'Search'}</button>
		{:else}
			<span class="search">
				<span aria-hidden="true">⌕</span>
				<input type="search" placeholder="Filter installed mods" bind:value={filter} aria-label="Filter installed mods" />
			</span>
		{/if}
		<form method="POST" action="?/upload" enctype="multipart/form-data" use:enhance bind:this={uploadForm}>
			<label class="button upload">
				Upload jars
				<input
					type="file"
					name="jars"
					accept=".jar"
					multiple
					class="visually-hidden"
					onchange={() => uploadForm?.requestSubmit()}
				/>
			</label>
		</form>
		<form method="POST" action="?/sync" use:enhance={syncEnhance}>
			<button
				type="submit"
				class="button-quiet"
				disabled={syncing}
				title="Track jars MineShell did not install and re-identify where pack mods came from"
			>
				{syncing ? 'Syncing' : 'Sync'}
			</button>
		</form>
	</div>
</div>

<Flash {form} />

{#if !data.supportsMods}
	<div class="notice info">
		<p>
			This server runs {data.modloader}, which does not load mods. Data packs work: Add mods offers their data pack
			releases. For mods, change the loader in Settings.
		</p>
	</div>
{/if}

{#if data.running}
	<div class="notice info">
		<p>The server is running. Mod changes are written now and load on the next restart.</p>
	</div>
{/if}

{#if data.counts.untracked > 0 || data.counts.missing > 0}
	<div class="notice warning spread">
		<p>
			{#if data.counts.untracked}
				{data.counts.untracked} jar{data.counts.untracked === 1 ? '' : 's'} in the folder that
				MineShell did not install.
			{/if}
			{#if data.counts.missing}
				{data.counts.missing} record{data.counts.missing === 1 ? '' : 's'} with no matching file.
			{/if}
		</p>
		<form method="POST" action="?/sync" use:enhance={syncEnhance}>
			<button class="button-quiet" type="submit" disabled={syncing}>
				{syncing ? 'Syncing' : 'Sync mods with database'}
			</button>
		</form>
	</div>
{/if}

{#if view === 'installed'}
	<div class="list-controls">
		<div class="chips" role="group" aria-label="Show">
			{#each [['all', 'All'], ['enabled', 'Enabled'], ['disabled', 'Disabled'], ['attention', 'Needs attention']] as const as [id, label] (id)}
				<button type="button" class="chip" aria-pressed={modFilter === id} onclick={() => (modFilter = id)}>
					{label}<span class="count">{filterCounts[id]}</span>
				</button>
			{/each}
		</div>
		{#if data.packName}
			<span class="pack-toggle">
				<input id="pack-mods" type="checkbox" bind:checked={packMods} />
				<label for="pack-mods">Allow changing single mods</label>
				<InfoTip
					label="About changing a modpack's mods"
					text={`This server runs ${data.packName}. A modpack is usually updated as a whole, from its version in Settings. Updating or switching single mods is meant for custom setups, and a later pack version change replaces them again.`}
				/>
			</span>
		{/if}
	</div>

	{#if visible.length === 0}
		<div class="empty">
			<p>
				{data.mods.length === 0
					? 'No mods installed. Add some from Modrinth or CurseForge, or upload a jar.'
					: 'Nothing matches that filter.'}
			</p>
		</div>
	{:else}
		<div class="table-box">
			<table class="mods">
				<thead>
					<tr>
						<th class="switch-col"><span class="visually-hidden">Enabled</span></th>
						<th>Mod</th>
						<th class="nowrap">Version</th>
						<th class="nowrap">Source</th>
						<th><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each visible as mod (mod.filePath)}
						<tr class:disabled={!mod.enabled} class:missing={mod.missing}>
							<td class="switch-col">
								{#if !mod.missing}
									<form method="POST" action="?/toggle" use:enhance>
										<input type="hidden" name="fileName" value={mod.fileName} />
										<input type="hidden" name="enabled" value={String(!mod.enabled)} />
										<button
											type="submit"
											class="switch"
											role="switch"
											aria-checked={mod.enabled}
											aria-label="{mod.enabled ? 'Disable' : 'Enable'} {mod.name}"
											title={mod.enabled ? 'Disable (renames the file to .jar.disabled)' : 'Enable'}
										></button>
									</form>
								{/if}
							</td>
							<td>
								<div class="mod-name">
									{#if mod.projectUrl}
										<a href={mod.projectUrl} target="_blank" rel="noreferrer">{mod.name}</a>
									{:else}
										<span>{mod.name}</span>
									{/if}
									{#if mod.fromPack}<span class="tag">pack</span>{/if}
									{#if mod.clientOnly}
										<span
											class="tag warn"
											title="Known to do nothing on a dedicated server, or to crash it. MineShell disables these when a pack installs them; re-enable it only if another mod needs it."
										>client-only</span>
									{/if}
									{#if mod.untracked}<span class="tag warn">untracked</span>{/if}
									{#if mod.missing}<span class="tag bad">file missing</span>{/if}
									{#if mod.locked}<span class="tag">locked</span>{/if}
								</div>
								<div class="faint small mono">
									{mod.fileName}{mod.sizeBytes ? ` · ${formatBytes(mod.sizeBytes)}` : ''}
								</div>
							</td>
							<td class="mono small nowrap">{mod.version ?? 'unknown'}</td>
							<td class="small nowrap source">{sourceLabel(mod.source)}</td>
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
										{#if canChange(mod)}
											<button
												type="button"
												class="button-quiet"
												disabled={changesLocked || data.running || data.busy}
												title={data.running
													? 'Stop the server to change mod versions'
													: changesLocked
														? 'Allow changing single mods first'
														: undefined}
												onclick={() => openVersions(mod.fileName)}
											>
												Versions
											</button>
										{/if}
										<button type="button" class="button-quiet" onclick={() => (pendingDelete = mod.fileName)}>
											Remove
										</button>
									</div>
								{/if}
							</td>
						</tr>
						{#if versionFor === mod.fileName}
							<tr class="version-row">
								<td colspan="5">
									{#if versionsLoading}
										<p class="muted small">Looking up versions of {mod.name}.</p>
									{:else if versionError}
										<p class="hint warn-text">{versionError}</p>
									{:else}
										<form
											method="POST"
											action="?/changeVersion"
											use:enhance={() => async ({ result, update }) => {
												await update({ reset: false });
												if (result.type === 'success') versionFor = null;
											}}
										>
											<input type="hidden" name="fileName" value={mod.fileName} />
											<input type="hidden" name="label" value={mod.name} />
											{#if packMods}<input type="hidden" name="packMods" value="on" />{/if}
											<div class="field">
												<label for="ver-{mod.fileName}">Switch {mod.name} to</label>
												<select id="ver-{mod.fileName}" name="versionId" bind:value={versionPick}>
													{#each versionList as v (v.id)}
														<option value={v.id}>{versionLabel(v)}</option>
													{/each}
												</select>
											</div>
											{#if versionDepsLoading}
												<p class="muted small">Checking what this version needs.</p>
											{:else if versionDeps}
												{@render dependencyList(versionDeps)}
											{/if}
											<div class="check">
												<input id="ver-snap-{mod.fileName}" type="checkbox" name="snapshot" />
												<label for="ver-snap-{mod.fileName}">
													Snapshot the world first ({formatBytes(data.snapshotPrompt.worldBytes)})
												</label>
											</div>
											<div class="button-row">
												<button
													class="button-primary"
													type="submit"
													disabled={!versionPick || versionList.find((v) => v.id === versionPick)?.installed}
												>
													Switch version
												</button>
												<button class="button-quiet" type="button" onclick={() => (versionFor = null)}>Cancel</button>
											</div>
										</form>
									{/if}
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
	<p class="faint small foot">
		{data.counts.enabled} of {data.counts.total} enabled. Disabling renames the file to <code>.jar.disabled</code>, which is
		what the loader looks at.
	</p>
{:else if view === 'updates'}
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
				{#if data.packName}
					<span class="pack-toggle">
						<input id="pack-mods-u" type="checkbox" bind:checked={packMods} />
						<label for="pack-mods-u">Allow changing single mods</label>
					</span>
				{/if}
				<button
					class="button-primary"
					type="button"
					onclick={checkUpdates}
					disabled={changesLocked || checking || data.running || data.busy}
					title={data.running ? 'Stop the server to update its mods' : changesLocked ? 'Allow changing single mods first' : undefined}
				>
					{checking ? 'Checking for updates' : 'Check for updates'}
				</button>
			</div>
		</div>
		{#if data.running}
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
						<button class="button-primary" type="submit" disabled={!chosenCount || data.running}>
							Update {chosenCount} mod{chosenCount === 1 ? '' : 's'}
						</button>
					</div>
				</div>
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
									{#if !u.enabled}<span class="faint small">disabled, stays disabled</span>{/if}
								</span>
								<span class="mono small versions">
									{u.currentVersion ?? '?'} → <span class="to">{u.targetVersion}</span>
								</span>
							</label>
						</li>
					{/each}
				</ul>
				{@render dependencyList(updateCheck.dependencies)}
				<SnapshotChoice prompt={data.snapshotPrompt} idPrefix="update-mods" />
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
{:else if view === 'browse'}
	<div class="browse-bar">
		<div class="segmented" role="group" aria-label="Source">
			{#each sources as s (s.id)}
				<button type="button" aria-pressed={source === s.id} onclick={() => (source = s.id)}>{s.label}</button>
			{/each}
		</div>
		<span class="faint small">
			Showing mods for {data.instance.modloaderLabel} {data.minecraftVersion}. Leave the search blank to browse popular ones.
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
					{searching ? 'Searching.' : 'Search, or press Search with nothing typed to browse popular mods.'}
				</li>
			{/each}
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
								{#each versions as v (v.id)}
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
									A data pack: it goes into <code>{data.datapacks.world}/datapacks</code>, not the mods folder. Packs that
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
														No build for {data.catalogLoader}
														{data.minecraftVersion}. Install it by hand if the mod needs it.
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
{:else}
	<div class="section-head">
		<div>
			<h2>Data packs</h2>
			<p>
				In <code>{data.datapacks.world}/datapacks</code>. Minecraft loads new ones when the world loads; on a running
				server, <code>/reload</code> loads them now. Ones that change world generation only affect new chunks.
			</p>
		</div>
	</div>
	{#if data.datapacks.packs.length === 0}
		<div class="empty"><p>No data packs. Data pack releases from Add mods land here.</p></div>
	{:else}
		<div class="table-box">
			<table>
				<thead>
					<tr>
						<th>Data pack</th>
						<th>Version</th>
						<th class="num">Size</th>
						<th><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each data.datapacks.packs as pack (pack.fileName)}
						<tr>
							<td>
								{#if pack.projectUrl}
									<a href={pack.projectUrl} target="_blank" rel="noreferrer">{pack.name}</a>
								{:else}
									<span class="mono small">{pack.name}</span>
								{/if}
								{#if pack.fromPack}<span class="tag">from the modpack</span>{/if}
								{#if pack.worldgen}<span class="tag warn" title="Adds or changes world generation">world generation</span>{/if}
							</td>
							<td class="mono small">{pack.version ?? ''}</td>
							<td class="num mono small">{pack.sizeBytes ? formatBytes(pack.sizeBytes) : 'folder'}</td>
							<td class="right">
								<form
									method="POST"
									action="?/removeDatapack"
									use:enhance={({ cancel }) => {
										const question =
											pack.worldgen && pack.loadedByWorld
												? `${pack.name} changes world generation, and this world has loaded it. Without it Minecraft may refuse to load the world at all. Take a snapshot on the World tab first. Remove it anyway?`
												: `Remove ${pack.name}?`;
										if (!confirm(question)) cancel();
									}}
								>
									<input type="hidden" name="fileName" value={pack.fileName} />
									<!-- The question above was the warning; the server refuses without this. -->
									<input type="hidden" name="force" value="on" />
									<button class="button-quiet">Remove</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
{/if}

<style>
	.num {
		text-align: right;
		white-space: nowrap;
	}

	.right {
		text-align: right;
	}

	.warn-text {
		color: var(--warning);
	}

	.tools {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding-bottom: 0.4rem;
	}

	.search {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 15rem;
		background: var(--bg-sunken);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
		padding: 0 0.6rem;
		color: var(--text-faint);
		font-size: 0.87rem;
	}

	.search input {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: 0;
		padding: 0.4rem 0;
		font-size: 0.88rem;
		outline: none;
	}

	label.upload {
		margin: 0;
		color: var(--text);
		font-size: 0.9rem;
	}

	.notice.spread {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.notice.spread p {
		margin: 0;
	}

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

	/* ---- installed */

	.list-controls {
		display: flex;
		gap: var(--space-3);
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}

	.chips {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.chip {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.2rem 0.7rem;
		border-radius: 12px;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--text-muted);
		font-size: 0.85rem;
		font-weight: 400;
	}

	.chip[aria-pressed='true'] {
		background: var(--panel);
		border-color: var(--line-strong);
		color: var(--text);
	}





	.switch-col {
		width: 3.5rem;
		padding-right: 0 !important;
	}

	/* A toggle switch: the form posts the opposite of the current state. */
	.switch {
		position: relative;
		width: 32px;
		height: 18px;
		padding: 0;
		border: 0;
		border-radius: 9px;
		background: var(--line-strong);
	}

	.switch::after {
		content: '';
		position: absolute;
		top: 3px;
		left: 3px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--text);
		transition: left 0.12s;
	}

	.switch[aria-checked='true'] {
		background: var(--accent);
	}

	.switch[aria-checked='true']::after {
		left: 17px;
	}

	.switch:hover:not(:disabled) {
		outline: 1px solid var(--accent-hover);
	}

	.mod-name {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.mod-name a {
		color: var(--text);
		text-decoration: none;
	}

	.mod-name a:hover {
		color: var(--accent-hover);
	}

	.source {
		color: var(--text-muted);
	}

	tr.disabled td:not(.switch-col) {
		opacity: 0.5;
	}

	tr.missing td {
		opacity: 0.8;
	}

	.row-actions {
		display: flex;
		gap: var(--space-1);
		justify-content: flex-end;
		align-items: center;
	}

	.row-actions button {
		font-size: 0.85rem;
		padding: 0.25rem 0.5rem;
	}

	.row-actions.confirm {
		gap: var(--space-2);
	}

	.row-actions.confirm span {
		color: var(--text-muted);
		white-space: nowrap;
	}

	.version-row td {
		background: var(--bg-sunken);
	}

	.version-row select {
		width: min(36rem, 100%);
	}

	.foot {
		margin: var(--space-3) 0 0;
	}

	.tag.ok {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 45%, var(--line-strong));
	}

	/* ---- updates and data packs */




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

	/* ---- add mods */

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

	ul.deps {
		border: 0;
		padding: 0 0 0 1.2rem;
		max-height: none;
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
