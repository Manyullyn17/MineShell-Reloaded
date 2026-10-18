<script lang="ts">
	import { can, type InstancePermission } from '#lib/shared/access.js';
	import ServerIcon from '#lib/components/ServerIcon.svelte';
	import { enhance } from '#lib/shared/forms.js';
	import type { SubmitFunction } from '$app/forms';
	import { refreshAll } from '$app/navigation';
	import StatusPill from '#lib/components/StatusPill.svelte';
	import Flash from '#lib/components/Flash.svelte';
	import { describeState, formatBytes, formatDuration, formatRelative } from '#lib/shared/format.js';
	import { isStopped, matchesDashboardFilters, needsAttention } from '#lib/shared/dashboard-filters.js';
	import { startAnyway } from '#lib/shared/startanyway.js';

	let { data } = $props();
	/** What this account may do on a server; the server checks every action again. */
	const may = (id: string, permission: InstancePermission) => can(data.access, id, permission);

	let busy = $state<string | null>(null);
	let search = $state('');
	let statusFilter = $state<'all' | 'running' | 'stopped' | 'attention'>('all');
	let selectedTagIds = $state<string[]>([]);
	let selectedMinecraftVersions = $state<string[]>([]);
	let selectedLoaders = $state<string[]>([]);
	let editingTagsFor = $state<string | null>(null);
	let filterPanel = $state<HTMLDetailsElement | null>(null);

	// Systemd state changes a second or two after the button click, so the page
	// re-reads itself on a slow tick rather than pretending it is instant.
	$effect(() => {
		const timer = setInterval(() => void refreshAll(), 5000);
		return () => clearInterval(timer);
	});

	const attention = $derived(data.instances.filter(needsAttention).length);
	const minecraftVersions = $derived([...new Set(data.instances.map((instance) => instance.minecraftVersion))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })));
	const loaders = $derived([...new Map(data.instances.map((instance) => [instance.modloader, instance.modloaderLabel])).entries()].sort((a, b) => a[1].localeCompare(b[1])));
	const visibleInstances = $derived.by(() => {
		return data.instances.filter((instance) => matchesDashboardFilters(instance, {
			search,
			status: statusFilter,
			tagIds: selectedTagIds,
			minecraftVersions: selectedMinecraftVersions,
			loaders: selectedLoaders
		}));
	});
	const selectedFilterCount = $derived(selectedTagIds.length + selectedMinecraftVersions.length + selectedLoaders.length);
	const hasFilters = $derived(!!search.trim() || statusFilter !== 'all' || selectedFilterCount > 0);
	function toggleTag(id: string) {
		selectedTagIds = selectedTagIds.includes(id)
			? selectedTagIds.filter((selected) => selected !== id)
			: [...selectedTagIds, id];
	}
	function toggleMinecraftVersion(version: string) {
		selectedMinecraftVersions = selectedMinecraftVersions.includes(version)
			? selectedMinecraftVersions.filter((value) => value !== version)
			: [...selectedMinecraftVersions, version];
	}
	function toggleLoader(id: string) {
		selectedLoaders = selectedLoaders.includes(id)
			? selectedLoaders.filter((value) => value !== id)
			: [...selectedLoaders, id];
	}
	function clearFilters() {
		search = '';
		statusFilter = 'all';
		selectedTagIds = [];
		selectedMinecraftVersions = [];
		selectedLoaders = [];
	}
	function closeFilterPanel() {
		if (filterPanel) filterPanel.open = false;
	}
	function onWindowClick(event: MouseEvent) {
		const target = event.target;
		if (filterPanel?.open && !filterPanel.contains(target as Node)) closeFilterPanel();
		if (editingTagsFor && (!(target instanceof Element) || target.closest('.card')?.getAttribute('data-instance-id') !== editingTagsFor)) {
			editingTagsFor = null;
		}
	}

	// The page reloads every few seconds, each time with a new pending promise;
	// keeping the last answer stops the line flashing back to its loading text.
	let causes = $state<Record<string, string>>({});
	$effect(() => {
		let current = true;
		data.causes.then((found) => current && (causes = found)).catch(() => undefined);
		return () => (current = false);
	});

	/**
	 * A card's buttons post to that server's own actions (`/instances/<id>?/power`,
	 * like its header), so every one names the server in its address. The default
	 * enhance would navigate there; the answer is shown here instead.
	 */
	let message = $state<{ ok?: boolean; message?: string } | null>(null);
	const action = (id: string, name: string) => `/instances/${encodeURIComponent(id)}?/${name}`;
	function inPlace(busyId: string | null = null): SubmitFunction {
		return () => {
			busy = busyId;
			return async ({ result: first, formElement, action }) => {
				const memoryWarned = first.type === 'failure' && (first.data as { memoryWarning?: boolean } | undefined)?.memoryWarning;
				const result = (await startAnyway(first, action)) ?? first;
				if (memoryWarned && result === first) {
					busy = null;
					return;
				}
				if (result.type === 'success' || result.type === 'failure') {
					message = (result.data as { ok?: boolean; message?: string }) ?? null;
				} else if (result.type === 'error') {
					message = { ok: false, message: result.error?.message ?? 'Something went wrong.' };
				}
				if (result.type === 'success') formElement.reset();
				await refreshAll();
				busy = null;
			};
		};
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={(event) => event.key === 'Escape' && closeFilterPanel()} />

<svelte:head><title>MineShell</title></svelte:head>

<header class="page-head">
	<div>
		<h1>Servers</h1>
		<p class="muted">
			{data.instances.length === 0
				? 'Nothing here yet.'
				: `${data.instances.filter((i) => i.running).length} of ${data.instances.length} running${attention ? ` · ${attention} need${attention === 1 ? 's' : ''} attention` : ''}`}
		</p>
	</div>
	{#if data.access.canCreate}<a class="button button-primary" href="/instances/new">Add a server</a>{/if}
</header>

<Flash form={message} />

<!-- What MineShell itself needs is for whoever looks after MineShell. -->
{#if !data.access.globalAdmin}
	<!-- nothing -->
{:else if !data.environment.systemdAvailable}
	<div class="notice error">
		<p>
			MineShell cannot reach the user's systemd instance, so servers cannot be started.
			{data.environment.systemdMessage}
		</p>
		<p>See <a href="/settings">MineShell settings</a> for what to check.</p>
	</div>
{:else if !data.environment.unitInstalled}
	<div class="notice warning">
		<p>
			The <code>{data.environment.templateUnit}</code> template is not installed yet. Install it from
			<a href="/settings">MineShell settings</a> before starting a server.
		</p>
	</div>
{/if}

{#if data.access.globalAdmin && data.environment.javaCount === 0}
	<div class="notice warning">
		<p>
			No Java runtime has been found on this machine. Install one, then rescan from
			<a href="/settings">MineShell settings</a>.
		</p>
	</div>
{/if}

{#if data.instances.length === 0}
	<div class="empty">
		{#if data.access.canCreate}
			<h2>Set up your first server</h2>
			<p>
				Start from a Modrinth or CurseForge modpack, or build one from a bare mod loader and add
				mods yourself.
			</p>
			<a class="button button-primary" href="/instances/new">Add a server</a>
		{:else}
			<h2>No servers for you yet</h2>
			<p>Your account has not been given any servers. Ask the owner or an admin of this MineShell.</p>
		{/if}
	</div>
{:else}
	<section class="list-tools panel" aria-label="Find servers">
		<label class="search-field">
			<span class="visually-hidden">Search servers</span>
			<input type="search" bind:value={search} placeholder="Search servers, packs, versions, loaders, or tags" />
		</label>
		<div class="list-controls">
			<div class="segmented" role="group" aria-label="Server status">
				{#each [
					{ id: 'all', label: 'All', count: data.instances.length },
					{ id: 'running', label: 'Running', count: data.instances.filter((i) => i.running).length },
					{ id: 'stopped', label: 'Stopped', count: data.instances.filter(isStopped).length },
					{ id: 'attention', label: 'Needs attention', count: attention }
				] as option (option.id)}
					<button type="button" aria-pressed={statusFilter === option.id} onclick={() => (statusFilter = option.id as typeof statusFilter)}>
						{option.label}<span class="count">{option.count}</span>
					</button>
				{/each}
			</div>
			{#if hasFilters}<button class="button-quiet" type="button" onclick={clearFilters}>Clear filters</button>{/if}
			<details class="tag-filter" bind:this={filterPanel}>
				<summary>Filters{#if selectedFilterCount}<span class="count">{selectedFilterCount}</span>{/if}</summary>
					<div class="tag-options">
						<p class="hint">Any selected value within a group matches; each selected group must match.</p>
						<fieldset>
							<legend>Custom tags</legend>
							{#if data.tags.length}
								{#each data.tags as tag (tag.id)}
									<label><input type="checkbox" checked={selectedTagIds.includes(tag.id)} onchange={() => toggleTag(tag.id)} />{tag.name}</label>
								{/each}
							{:else}<span class="small faint">No custom tags yet.</span>{/if}
						</fieldset>
						<fieldset>
							<legend>Minecraft version</legend>
							{#each minecraftVersions as version (version)}
								<label><input type="checkbox" checked={selectedMinecraftVersions.includes(version)} onchange={() => toggleMinecraftVersion(version)} />{version}</label>
							{/each}
						</fieldset>
						<fieldset>
							<legend>Modloader</legend>
							{#each loaders as [id, label] (id)}
								<label><input type="checkbox" checked={selectedLoaders.includes(id)} onchange={() => toggleLoader(id)} />{label}</label>
							{/each}
						</fieldset>
				</div>
			</details>
		</div>
		{#if selectedFilterCount}
			<div class="selected-tags" aria-label="Selected tag filters">
				{#each selectedTagIds as id (id)}
					{@const tag = data.tags.find((t) => t.id === id)}
					{#if tag}<button type="button" class="tag" onclick={() => toggleTag(id)} aria-label="Remove {tag.name} tag filter">Tag: {tag.name} ×</button>{/if}
				{/each}
				{#each selectedMinecraftVersions as version (version)}
					<button type="button" class="tag" onclick={() => toggleMinecraftVersion(version)} aria-label="Remove Minecraft {version} filter">MC {version} ×</button>
				{/each}
				{#each selectedLoaders as id (id)}
					{@const loader = loaders.find(([loaderId]) => loaderId === id)}
					{#if loader}<button type="button" class="tag" onclick={() => toggleLoader(id)} aria-label="Remove {loader[1]} filter">Loader: {loader[1]} ×</button>{/if}
				{/each}
			</div>
		{/if}
		<p class="small muted result-count">Showing {visibleInstances.length} of {data.instances.length} servers</p>
	</section>
	{#if visibleInstances.length === 0}
		<div class="empty">
			<p>No servers match these filters.</p>
			<button type="button" class="button-quiet" onclick={clearFilters}>Clear filters</button>
		</div>
	{:else}<div class="cards">
		{#each visibleInstances as instance (instance.id)}
			{@const tone = describeState(instance.active, instance.sub, instance.starting).tone}
			<article class="panel card" data-tone={tone} data-instance-id={instance.id}>
				<div class="card-head">
					<div class="title">
						<ServerIcon id={instance.id} name={instance.name} iconVersion={instance.iconVersion} size={32} />
						<a href="/instances/{instance.id}"><h2>{instance.name}</h2></a>
					</div>
					<div class="status">
						<StatusPill active={instance.active} sub={instance.sub} starting={instance.starting} />
						{#if may(instance.id, 'settings.edit')}
							<form method="POST" action={action(instance.id, 'pin')} use:enhance={inPlace()}>
								<button
									class="pin hit-area"
									class:pinned={instance.pinned}
									type="submit"
									title={instance.pinned ? 'Unpin from the top' : 'Pin to the top'}
									aria-label={instance.pinned
										? `Unpin ${instance.name}`
										: `Pin ${instance.name} to the top`}
								>
									{instance.pinned ? '★' : '☆'}
								</button>
							</form>
						{:else if instance.pinned}
							<span class="pin pinned" title="Pinned to the top">★</span>
						{/if}
					</div>
					<!-- Across the whole card, not only beside the status, so they stay on one line when they fit. -->
					<div class="tags">
						<button type="button" class="tag filter-chip" aria-label="Filter Minecraft version {instance.minecraftVersion}" onclick={() => toggleMinecraftVersion(instance.minecraftVersion)}>{instance.minecraftVersion}</button>
						<button type="button" class="tag accent filter-chip" aria-label="Filter by {instance.modloaderLabel}" onclick={() => toggleLoader(instance.modloader)}>{instance.modloaderLabel}</button>
						<span class="tag">:{instance.port}</span>
						<div class="server-tags">
							{#each instance.tags as tag (tag.id)}
								{#if editingTagsFor === instance.id}
									<span class="tag-item"><span class="tag-name">{tag.name}</span>
										<form method="POST" action={action(instance.id, 'removeTag')} use:enhance={inPlace()}>
											<input type="hidden" name="tagId" value={tag.id} />
											<button class="tag-remove" aria-label="Remove tag {tag.name}" title="Remove {tag.name}">×</button>
										</form>
									</span>
								{:else}
									<button type="button" class="tag" aria-label="Filter by tag {tag.name}" onclick={() => toggleTag(tag.id)}>{tag.name}</button>
								{/if}
							{/each}
						</div>
						{#if may(instance.id, 'settings.edit')}<button type="button" class="button-quiet manage-tags" aria-expanded={editingTagsFor === instance.id} onclick={() => (editingTagsFor === instance.id ? (editingTagsFor = null) : (editingTagsFor = instance.id))}>{editingTagsFor === instance.id ? 'Done' : 'Manage tags'}</button>{/if}
					</div>
					{#if editingTagsFor === instance.id}
						<div class="tag-editor">
							<form method="POST" action={action(instance.id, 'addTag')} use:enhance={inPlace()} class="tag-add-form">
								<input name="name" maxlength="32" placeholder="Create a new tag" aria-label="Create a new server tag" autocomplete="off" required />
								<button class="button button-quiet" type="submit">Create tag</button>
							</form>
							{#if data.tags.some((tag) => !instance.tags.some((assigned) => assigned.id === tag.id))}
								<div class="existing-tags" aria-label="Add an existing tag">
									<span class="small muted">Add existing:</span>
									{#each data.tags.filter((tag) => !instance.tags.some((assigned) => assigned.id === tag.id)) as tag (tag.id)}
										<form method="POST" action={action(instance.id, 'addTag')} use:enhance={inPlace()}>
											<input type="hidden" name="tagId" value={tag.id} />
											<button class="tag-choice" type="submit">+ {tag.name}</button>
										</form>
									{/each}
								</div>
							{/if}
						</div>
					{/if}
				</div>

				{#if instance.status === 'provisioning'}
					<p class="alert info">
						Still installing. Watch progress under <a href="/tasks">Activity</a>.
					</p>
				{:else if instance.status === 'failed'}
					<p class="alert error">Setup failed: {instance.statusMessage}</p>
				{:else if instance.statusMessage}
					<p class="alert warning">{instance.statusMessage}</p>
				{/if}

				{#if tone === 'failed' && instance.status === 'ready'}
					<p class="alert error">
						{instance.gaveUpAfter
							? `Crashed ${instance.gaveUpAfter} times in a row, so systemd stopped restarting it.`
							: 'The last run crashed.'}
						{#if causes[instance.id]}Likely cause: {causes[instance.id]}{:else}The overview shows the final output.{/if}
					</p>
				{/if}

				{#if !instance.eulaAccepted}
					<p class="alert warning">
						The Minecraft EULA has not been accepted for this server.
						<a href="/instances/{instance.id}">Review and accept it</a> to start.
					</p>
				{/if}

				{#if instance.javaWarning}
					<p class="alert warning">{instance.javaWarning}</p>
				{/if}

				<dl class="stats">
					<div>
						<dt>Uptime</dt>
						<dd class="mono">{instance.running && !instance.starting ? formatDuration(instance.uptimeMs) : '-'}</dd>
					</div>
					<div>
						<dt>Players</dt>
						<dd class="mono">
							{instance.players ? `${instance.players.online}/${instance.players.max}` : '-'}
						</dd>
					</div>
					<div>
						<dt>Memory</dt>
						<dd class="mono">
							{instance.running && instance.memoryBytes ? formatBytes(instance.memoryBytes) : '-'}
						</dd>
					</div>
					<div>
						<dt>CPU</dt>
						<dd class="mono">
							{!instance.running || instance.cpuPercent === null ? '-' : `${instance.cpuPercent.toFixed(0)}%`}
						</dd>
					</div>
				</dl>

				{#if instance.players?.names.length}
					<p class="small muted online">Online: {instance.players.names.join(', ')}</p>
				{/if}

				<footer>
					<form method="POST" action={action(instance.id, 'power')} use:enhance={inPlace(instance.id)}>
						<div class="button-row">
							{#if !may(instance.id, 'power')}
								{#if tone === 'failed' && instance.status === 'ready'}
									<a class="button button-danger" href="/instances/{instance.id}">See what went wrong</a>
								{/if}
							{:else if instance.running}
								<button
									class="button-primary"
									name="verb"
									value="stop"
									disabled={busy === instance.id}
								>
									Stop
								</button>
								<button name="verb" value="restart" disabled={busy === instance.id}>Restart</button>
							{:else if tone === 'failed' && instance.status === 'ready'}
								<a class="button button-danger" href="/instances/{instance.id}">See what went wrong</a>
								<button name="verb" value="start" disabled={busy === instance.id}>Start</button>
							{:else}
								<button
									class="button-primary"
									name="verb"
									value="start"
									disabled={busy === instance.id || instance.status !== 'ready'}
								>
									Start
								</button>
							{/if}
							{#if may(instance.id, 'console.read')}<a class="button" href="/instances/{instance.id}/console">Console</a>{/if}
						</div>
					</form>
					{#if instance.schedule !== 'Off'}
						<p class="small faint schedule">
							Scheduled restart: {instance.schedule.toLowerCase()}, next {formatRelative(
								instance.nextRestartAt
							)}
						</p>
					{/if}
				</footer>
			</article>
		{/each}
	</div>{/if}
{/if}

<style>
	.page-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-4);
		margin-bottom: var(--space-5);
		flex-wrap: wrap;
	}

	.page-head p {
		margin: var(--space-1) 0 0;
	}

	.list-tools {
		padding: var(--space-3) var(--space-4);
		margin: 0 0 var(--space-4);
	}

	.search-field input { width: 100%; }
	.list-controls { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; margin-top: var(--space-3); }
	.list-controls .segmented { flex: 1 1 auto; }
	.list-controls .segmented button { white-space: nowrap; }
	.count { margin-left: 0.3rem; font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-faint); }
	.tag-filter { position: relative; }
	.tag-filter summary { cursor: pointer; padding: 0.45rem 0.7rem; border: 1px solid var(--line); border-radius: var(--radius); }
	.tag-options { position: absolute; z-index: 10; top: calc(100% + 0.3rem); right: 0; min-width: 13rem; max-height: 18rem; overflow: auto; padding: var(--space-3); background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 10px 24px rgba(0, 0, 0, 0.22); }
	.tag-options p { margin: 0 0 var(--space-2); }
	.tag-options fieldset { border: 0; border-top: 1px solid var(--line); margin: var(--space-2) 0 0; padding: var(--space-2) 0 0; }
	.tag-options legend { padding: 0; color: var(--text-faint); font-size: 0.78rem; font-weight: 600; }
	.tag-options label { display: flex; align-items: center; gap: var(--space-2); padding: 0.2rem 0; font-weight: 400; }
	.tag-options input { width: auto; }
	.result-count { margin: var(--space-2) 0 0; }
	.server-tags { display: flex; align-items: center; flex-wrap: wrap; gap: 0.3rem; }
	.selected-tags { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1); margin-top: var(--space-2); }
	.selected-tags .tag { border: 0; cursor: pointer; }
	.filter-chip { cursor: pointer; background: transparent; }
	.server-tags .tag { border: 0; display: inline-flex; align-items: center; gap: 0.2rem; }
	.tag-item { display: inline-flex; align-items: center; gap: 0.2rem; padding: 0.12rem 0.35rem 0.12rem 0.5rem; border: 1px solid var(--line-strong); border-radius: 999px; color: var(--text-muted); background: var(--panel-raised); font: 0.75rem var(--font-mono); }
	.tag-name { padding: 0; }
	.server-tags button.tag { cursor: pointer; }
	.server-tags button.tag:hover { color: var(--accent-hover); }
	.server-tags form { display: inline-flex; }
	.tag-editor { display: flex; align-items: center; flex-wrap: wrap; gap: 0.3rem; margin-top: var(--space-1); }
	.tag-remove { border: 0; background: transparent; color: var(--text-faint); padding: 0 0.2rem; font: inherit; cursor: pointer; }
	.tag-add-form { display: flex; align-items: center; gap: var(--space-1); flex-wrap: nowrap; flex: 1 1 100%; padding: var(--space-2) 0; }
	.tag-add-form input { width: min(14rem, 100%); min-width: 0; flex: 0 1 14rem; }
	.tag-add-form button { flex: none; white-space: nowrap; }
	.existing-tags { display: flex; align-items: center; flex-wrap: wrap; gap: 0.35rem; flex: 1 1 100%; padding: 0.1rem 0 var(--space-1); }
	.existing-tags form { margin: 0; }
	.tag-choice { padding: 0.2rem 0.5rem; border: 1px dashed var(--line-strong); border-radius: 999px; background: transparent; color: var(--text-muted); font-size: 0.78rem; cursor: pointer; }
	.tag-choice:hover { border-style: solid; color: var(--text); }
	.manage-tags { padding: 0.1rem 0.4rem; font-size: 0.78rem; }

	@media (max-width: 760px) {
		.list-controls { align-items: stretch; }
		.list-controls .segmented { width: 100%; overflow-x: auto; }
	}

	/* Explicit column count rather than auto-fit: on a wide screen auto-fit
	   happily fitted five 22rem columns into one row, which is not a useful
	   way to read a server list. Change --cards-per-row (here and in the two
	   breakpoints below) to adjust; a stored user preference would only need
	   to override this one value.

	   align-items: stretch, not start, so every card in a row shares the
	   tallest one's height - otherwise a card with fewer tags or no stats
	   ends short and the row looks ragged. */
	.cards {
		--cards-per-row: 3;
		display: grid;
		grid-template-columns: repeat(var(--cards-per-row), minmax(0, 1fr));
		gap: var(--space-4);
		align-items: stretch;
	}

	@media (max-width: 1200px) {
		.cards {
			--cards-per-row: 2;
		}
	}

	@media (max-width: 760px) {
		.cards {
			--cards-per-row: 1;
		}
	}

	.card {
		border-top: 3px solid var(--text-faint);
		padding: 1.1rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}

	/*
	 * .panel + .panel (in app.css) adds margin-top for panels stacked in
	 * normal document flow elsewhere in the app; it doesn't know these are
	 * grid siblings, and fires on every card except the first - exactly what
	 * made one card stretch taller than the rest under align-items: stretch.
	 * The grid's own gap already spaces these uniformly in both directions.
	 * A bare `.card { margin-top: 0 }` has lower specificity than
	 * `.panel + .panel` (one class vs. two) and would lose regardless of
	 * stylesheet order, so this three-class selector deliberately outranks it.
	 */
	.cards > .panel.card {
		margin-top: 0;
	}

	.card > :last-child {
		margin-top: auto;
	}

	.card[data-tone='running'] {
		border-top-color: var(--success);
	}
	.card[data-tone='failed'] {
		border-top-color: var(--error);
	}
	.card[data-tone='busy'] {
		border-top-color: var(--warning);
	}

	/* Pinning is what reorders this list, so the control belongs here rather
	   than only on a page where its effect is invisible. */
	.pin {
		background: none;
		border: 0;
		padding: 0 0.2rem;
		font-size: 1.05rem;
		line-height: 1;
		color: var(--text-faint);
	}

	.pin:hover {
		color: var(--accent-hover);
	}

	.pin.pinned {
		color: var(--accent);
	}

	/* The status goes under the name when the name's longest word and it do not fit side by side. */
	.card-head {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.4rem 0.6rem;
	}

	.title {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex: 1 1 min-content;
		min-width: 0;
	}

	.title a {
		min-width: 0;
	}

	.title h2 {
		font-size: 1.1rem;
		/* Only a word wider than the whole card breaks. */
		overflow-wrap: break-word;
	}

	.status {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		flex: none;
		margin-left: auto;
	}

	.title a {
		text-decoration: none;
		color: var(--text);
	}

	.title a:hover h2 {
		color: var(--accent-hover);
	}

	.tags {
		grid-column: 1 / -1;
		display: flex;
		gap: var(--space-1);
		flex-wrap: wrap;
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: var(--space-2);
		margin: 0;
		padding: var(--space-3) 0;
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
	}

	.stats dt {
		font-size: 0.77rem;
		color: var(--text-faint);
	}

	.stats dd {
		margin: 0;
		font-size: 1rem;
	}

	.online {
		margin: 0;
	}

	.schedule {
		margin: var(--space-3) 0 0;
	}

	.alert {
		margin: 0;
		padding: 0.55rem var(--space-3);
		border-radius: var(--radius);
		font-size: 0.87rem;
	}
	.alert.error {
		color: color-mix(in srgb, var(--error) 70%, var(--text));
		background: color-mix(in srgb, var(--error) 10%, transparent);
	}
	.alert.warning {
		color: color-mix(in srgb, var(--warning) 80%, var(--text));
		background: color-mix(in srgb, var(--warning) 9%, transparent);
	}
	.alert.info {
		color: var(--text);
		background: color-mix(in srgb, var(--info) 10%, transparent);
	}

	.empty h2 {
		margin-bottom: var(--space-2);
	}

	.empty .button {
		margin-top: var(--space-3);
	}
</style>
