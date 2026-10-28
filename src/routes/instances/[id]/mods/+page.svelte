<script lang="ts">
	import { page } from '$app/state';
	import { streamed } from '#lib/shared/streamed.svelte.js';
	import DatapackUpdates from './DatapackUpdates.svelte';
	import { can, type InstancePermission } from '#lib/shared/access.js';
	import type { SubmitFunction } from '$app/forms';
	import { enhance } from '#lib/shared/forms.js';
	import { dropzone } from '#lib/shared/dropzone.js';
	import { refreshAll } from '$app/navigation';
	import Flash from '#lib/components/Flash.svelte';
	import InfoTip from '#lib/components/InfoTip.svelte';
	import { formatBytes } from '#lib/shared/format.js';
	import { webLink } from '#lib/shared/links.js';
	import BisectPanel from './BisectPanel.svelte';
	import DependencyList, { type DependencyPlan } from './DependencyList.svelte';
	import ModBrowser, { SOURCES } from './ModBrowser.svelte';
	import ModUpdates from './ModUpdates.svelte';
	import VersionPicker from '#lib/components/VersionPicker.svelte';

	let { data, form } = $props();
	/** What this account may do here; the server checks every action again. */
	const may = (permission: InstancePermission) => can(data.access, data.instance.id, permission);

	// The bisect assistant's search changes the state with every test: follow it.
	$effect(() => {
		if (!data.bisect.running) return;
		const timer = setInterval(() => void refreshAll(), 5000);
		return () => clearInterval(timer);
	});

	let filter = $state('');
	/** Which sub-tab is open. */
	// The overview's mod update notice links to ?view=updates.
	// svelte-ignore state_referenced_locally
	let view = $state<'installed' | 'updates' | 'browse' | 'datapacks'>(page.url.searchParams.get('view') === 'updates' ? 'updates' : 'installed');
	let modFilter = $state<'all' | 'enabled' | 'disabled' | 'attention'>('all');
	let uploadForm = $state<HTMLFormElement | null>(null);
	let jarInput = $state<HTMLInputElement | null>(null);
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

	const duplicatesInfo = streamed(() => data.duplicates);
	const duplicates = $derived((duplicatesInfo.ready ? duplicatesInfo.value : null) ?? []);
	const duplicateFiles = $derived(new Set(duplicates.flatMap((d) => d.files)));
	const requiredByInfo = streamed(() => data.requiredBy);
	/** By file name, the enabled mods that need it. */
	const neededBy = $derived((requiredByInfo.ready ? requiredByInfo.value : null) ?? {});
	/** "A, B and 3 more", for a row; the question before disabling or deleting names all of them. */
	const nameList = (names: string[], max = names.length) =>
		names.length <= max
			? names.slice(0, -1).join(', ') + (names.length > 1 ? ' and ' : '') + names[names.length - 1]
			: `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
	const needQuestion = (mod: { name: string; fileName: string }, doing: string) => {
		const names = neededBy[mod.fileName];
		return `${nameList(names, 12)} ${names.length === 1 ? 'needs' : 'need'} ${mod.name}: the server will not start without it. ${doing} it anyway?`;
	};
	/**
	 * Untracked jars, records without a file, enabled client-only mods, duplicates and
	 * disabled mods that enabled ones need ask to be looked at.
	 */
	const needsAttention = (m: (typeof data.mods)[number]) =>
		m.untracked || m.missing || (m.clientOnly && m.enabled) || duplicateFiles.has(m.fileName) || (!m.enabled && !!neededBy[m.fileName]);
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

	// ---- the other sub-tabs: kept mounted, so a check or search outlives switching tabs
	let browser = $state<ModBrowser | null>(null);
	let source = $state('modrinth');
	let term = $state('');
	let searching = $state(false);
	let updatesFound = $state(0);
</script>

<div class="subhead">
	<nav class="subtabs" aria-label="Mods sections">
		<button type="button" aria-current={view === 'installed' ? 'page' : undefined} onclick={() => (view = 'installed')}>
			Installed<span class="count">{data.counts.total}</span>
		</button>
		{#if may('mods')}
			<button type="button" aria-current={view === 'updates' ? 'page' : undefined} onclick={() => (view = 'updates')}>
				Updates{#if updatesFound}<span class="badge">{updatesFound}</span>{/if}
			</button>
		{/if}
		{#if may('mods') || may('datapacks')}
			<button type="button" aria-current={view === 'browse' ? 'page' : undefined} onclick={() => (view = 'browse')}>
				{may('mods') ? 'Add mods' : 'Add data packs'}
			</button>
		{/if}
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
					placeholder="Search {SOURCES.find((s) => s.id === source)?.label}"
					aria-label="Search mods"
					onkeydown={(e) => e.key === 'Enter' && browser?.search()}
				/>
			</span>
			<button type="button" onclick={() => browser?.search()} disabled={searching}>{searching ? 'Searching' : 'Search'}</button>
		{:else}
			<span class="search">
				<span aria-hidden="true">⌕</span>
				<input type="search" placeholder="Filter installed mods" bind:value={filter} aria-label="Filter installed mods" />
			</span>
		{/if}
		{#if may('mods')}
		<form method="POST" action="?/upload" enctype="multipart/form-data" use:enhance bind:this={uploadForm}>
			<label class="button upload">
				Upload jars
				<input
					bind:this={jarInput}
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
		{/if}
		{#if may('files')}
			<a class="button button-quiet" href="/instances/{encodeURIComponent(data.instance.id)}/export" title="A pack players import into their launcher">Export pack</a>
		{/if}
		<a class="button button-quiet" href="/instances/{encodeURIComponent(data.instance.id)}/export/mods" title="The mods as Markdown, text, HTML, CSV or JSON">Mod list</a>
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
		<p>
			The server is running. Adding, removing, enabling and disabling mods is written now and loads on the next
			restart. Changing mod versions and updating mods need the server stopped: each is one operation that is undone
			as a whole if it fails, and can snapshot the world first.
		</p>
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
		{#if may('mods')}
			<form method="POST" action="?/sync" use:enhance={syncEnhance}>
				<button class="button-quiet" type="submit" disabled={syncing}>
					{syncing ? 'Syncing' : 'Sync mods with database'}
				</button>
			</form>
		{/if}
	</div>
{/if}

<BisectPanel
	active={view === 'installed'}
	bisect={data.bisect}
	mods={data.mods}
	running={data.running}
	mayMods={may('mods')}
	mayStart={may('mods') && may('power')}
/>

{#if view === 'installed' && duplicates.length}
	<div class="notice warning duplicates">
		<p>
			<strong>{duplicates.length === 1 ? 'A mod is' : `${duplicates.length} mods are`} in mods/ twice.</strong> The loader refuses to
			start with the same mod twice (often one copy from Modrinth and one from CurseForge, under different file names). Keep
			one of each and disable the other.
		</p>
		<ul>
			{#each duplicates as dup (dup.files.join('|'))}
				<li>
					<span class="dup-name">{dup.name} <span class="faint mono small">({dup.id})</span></span>
					{#each dup.files as file (file)}
						<form method="POST" action="?/toggle" use:enhance class="dup-file">
							<input type="hidden" name="fileName" value={file} />
							<input type="hidden" name="enabled" value="false" />
							<span class="mono small">{file}</span>
							{#if may('mods')}<button class="button-quiet" type="submit">Disable</button>{/if}
						</form>
					{/each}
				</li>
			{/each}
		</ul>
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
				<input id="pack-mods" type="checkbox" class="switch" role="switch" bind:checked={packMods} disabled={data.running} />
				<label for="pack-mods">Allow changing single mods</label>
				{#if data.running}<span class="faint">· stop the server first</span>{/if}
				<InfoTip
					label="About changing a modpack's mods"
					text={`This server runs ${data.packName}. A modpack is usually updated as a whole, from its version in Settings. Updating or switching single mods is meant for custom setups, and a later pack version change replaces them again.`}
				/>
			</span>
		{/if}
	</div>

	<!-- Without mod management the list shows, its switches and buttons disabled. -->
	<fieldset class="plain" disabled={!may('mods')}>
	<div use:dropzone={{ input: jarInput, label: 'Drop .jar files to add them', disabled: !may('mods') }}>
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
									<form
										method="POST"
										action="?/toggle"
										use:enhance={({ cancel }) => {
											if (mod.enabled && neededBy[mod.fileName] && !confirm(needQuestion(mod, 'Disable'))) cancel();
										}}
									>
										<input type="hidden" name="fileName" value={mod.fileName} />
										<input type="hidden" name="enabled" value={String(!mod.enabled)} />
										<button
											type="submit"
											class="switch hit-area"
											role="switch"
											aria-checked={mod.enabled}
											aria-label="{mod.enabled ? 'Disable' : 'Enable'} {mod.name}"
											title={mod.enabled ? 'Disable (renames the file to .jar.disabled)' : 'Enable'}
										></button>
									</form>
								{/if}
							</td>
							<td class="mod-cell">
								<div class="mod-name">
									{#if webLink(mod.projectUrl)}
										<a href={webLink(mod.projectUrl)} target="_blank" rel="noreferrer">{mod.name}</a>
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
									{#if data.cleanroomOff[mod.fileName]}
										<span class="tag" title="Disabled because it breaks on Cleanroom or Cleanroom already does its job. {data.cleanroomOff[mod.fileName]}"
											>off for Cleanroom</span
										>
									{/if}
									{#if mod.untracked}<span class="tag warn">untracked</span>{/if}
									{#if mod.missing}<span class="tag bad">file missing</span>{/if}
									{#if mod.locked}
										<span class="tag" title="Held at this version: update checks leave it out. Versions can still switch it.">held</span>
									{/if}
								</div>
								<div class="faint small mono">
									{mod.fileName}{mod.sizeBytes ? ` · ${formatBytes(mod.sizeBytes)}` : ''}
								</div>
								{#if neededBy[mod.fileName] && !mod.missing}
									{@const names = neededBy[mod.fileName]}
									<div class="small needed-by" class:warn-text={!mod.enabled} title={names.length > 3 ? names.join(', ') : undefined}>
										{mod.enabled ? 'Needed by' : 'Off, but needed by'} {nameList(names, 3)}
									</div>
								{/if}
							</td>
							<td class="mono small version">{mod.version ?? 'unknown'}</td>
							<td class="small nowrap source">{sourceLabel(mod.source)}</td>
							<td>
								{#if pendingDelete === mod.fileName}
									<div class="row-actions confirm">
										<span class="small" class:long={neededBy[mod.fileName] && mod.enabled}>
											{neededBy[mod.fileName] && mod.enabled ? needQuestion(mod, 'Delete') : 'Delete this mod?'}
										</span>
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
											<form method="POST" action="?/lock" use:enhance>
												<input type="hidden" name="fileName" value={mod.fileName} />
												<input type="hidden" name="locked" value={String(!mod.locked)} />
												<button
													type="submit"
													class="button-quiet"
													title={mod.locked ? 'Put it back in update checks' : 'Keep this version: update checks leave it out'}
												>
													{mod.locked ? 'Release' : 'Hold'}
												</button>
											</form>
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
												<VersionPicker
													id="ver-{mod.fileName}"
													name="versionId"
													bind:value={versionPick}
													options={versionList.map((v) => ({ value: v.id, label: versionLabel(v), prerelease: v.channel !== 'release' }))}
												/>
											</div>
											{#if versionDepsLoading}
												<p class="muted small">Checking what this version needs.</p>
											{:else if versionDeps}
												<DependencyList plan={versionDeps} />
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
	</div>
	</fieldset>
	<p class="faint small foot">
		{data.counts.enabled} of {data.counts.total} enabled. Disabling renames the file to <code>.jar.disabled</code>, which is
		what the loader looks at.
	</p>
{:else if view === 'datapacks'}
	<div class="section-head">
		<div>
			<h2>Data packs</h2>
			<p>
				In <code>{data.datapacks.world}/datapacks</code>. Minecraft loads new ones when the world loads; on a running
				server, <code>/reload</code> loads them now. Ones that change world generation only affect new chunks.
			</p>
		</div>
	</div>
	{#if may('datapacks') && data.datapacks.packs.some((p) => p.tracked)}
		<DatapackUpdates instanceId={data.instance.id} running={data.running} busy={data.busy} snapshotPrompt={data.snapshotPrompt} />
	{/if}
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
								{#if webLink(pack.projectUrl)}
									<a href={webLink(pack.projectUrl)} target="_blank" rel="noreferrer">{pack.name}</a>
								{:else}
									<span class="mono small">{pack.name}</span>
								{/if}
								{#if pack.fromPack}<span class="tag">from the modpack</span>{/if}
								{#if pack.worldgen}<span class="tag warn" title="Adds or changes world generation">world generation</span>{/if}
							</td>
							<td class="mono small">{pack.version ?? ''}</td>
							<td class="num mono small">{pack.sizeBytes ? formatBytes(pack.sizeBytes) : 'folder'}</td>
							<td class="right">
								{#if may('datapacks')}
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
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
{/if}

<ModUpdates
	active={view === 'updates'}
	instanceId={data.instance.id}
	packName={data.packName}
	running={data.running}
	busy={data.busy}
	snapshotPrompt={data.snapshotPrompt}
	bind:packMods
	bind:available={updatesFound}
	checkOnOpen={page.url.searchParams.get('view') === 'updates'}
/>

<ModBrowser
	bind:this={browser}
	active={view === 'browse'}
	instanceId={data.instance.id}
	modloader={data.modloader}
	modloaderLabel={data.instance.modloaderLabel}
	minecraftVersion={data.minecraftVersion}
	catalogLoader={data.catalogLoader}
	compatibleLoaders={data.compatibleLoaders}
	mods={data.mods}
	datapackWorld={data.datapacks.world}
	bind:source
	bind:term
	bind:searching
/>

<style>
	.duplicates ul {
		list-style: none;
		margin: var(--space-2) 0 0;
		padding: 0;
	}

	.duplicates li + li {
		margin-top: var(--space-2);
	}

	.dup-name {
		display: block;
	}

	.dup-file {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	fieldset.plain {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}

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
		flex-wrap: wrap;
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
		flex-wrap: wrap;
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

	/* Smaller than elsewhere: one per row of a long table. */
	.switch-col .switch {
		width: 32px;
		height: 18px;
	}

	.switch-col .switch::after {
		width: 12px;
		height: 12px;
	}

	.switch-col .switch[aria-checked='true']::after {
		left: 17px;
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

	/* Names, file names and versions can be long single words: they break so the table fits. */
	.mod-cell,
	.version {
		overflow-wrap: anywhere;
	}

	.version {
		min-width: 6rem;
	}

	/* Breaking anywhere lets the table squeeze a column to a letter or two: on a phone
	   each name stood one letter per line, rows 700 px tall. The table scrolls instead. */
	.mod-cell {
		min-width: 12rem;
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

	/* The question naming the mods that need this one is a sentence, not a word. */
	.row-actions.confirm span.long {
		white-space: normal;
		max-width: 22rem;
		text-align: right;
	}

	.needed-by {
		color: var(--text-muted);
	}

	.needed-by.warn-text {
		color: var(--warning);
	}

	.version-row td {
		background: var(--bg-sunken);
	}

	.version-row :global(.version-picker) {
		width: min(36rem, 100%);
	}

	.foot {
		margin: var(--space-3) 0 0;
	}
</style>
