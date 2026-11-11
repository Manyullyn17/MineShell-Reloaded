<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '#lib/shared/forms.js';
	import { fitToViewport } from '#lib/shared/fitToViewport.js';
	import { reveal } from '#lib/shared/reveal.js';
	import { SEARCH_DELAY_MS } from '#lib/shared/modsearch.js';
	import { formatBytes, formatDateTime } from '#lib/shared/format.js';
	import FormattedTextInput from '#lib/components/FormattedTextInput.svelte';
	import ResourcePackPromptPreview from '#lib/components/ResourcePackPromptPreview.svelte';
	import type { PageData } from './$types';

	/**
	 * The Resource pack sub-tab (resourcepacks.ts): the pack players are offered when they join,
	 * picked from Modrinth or CurseForge (players download it from there) or typed as an address,
	 * and from 1.17 whether they must take it and what they are asked. Stays mounted while another
	 * sub-tab is open (`active` false), so a search is kept.
	 */
	let {
		active,
		pack,
		running,
		toApply,
		menuBlur,
		minecraftVersion,
		canEdit,
		source = $bindable('modrinth'),
		term = $bindable(''),
		searching = $bindable(false)
	}: {
		active: boolean;
		pack: PageData['resourcePack'];
		running: boolean;
		/** Changed since this run started: players get it at the next start. */
		toApply: boolean;
		/** The version shows a blurred world behind menus (1.20.5+), else dirt: the preview's backdrop. */
		menuBlur: boolean;
		minecraftVersion: string;
		/** settings.edit: changing server.properties. */
		canEdit: boolean;
		/** The search box is in the page's tool row, as for Add mods. */
		source?: 'modrinth' | 'curseforge';
		term?: string;
		searching?: boolean;
	} = $props();

	const SOURCES = [
		{ id: 'modrinth', label: 'Modrinth' },
		{ id: 'curseforge', label: 'CurseForge' }
	] as const;
	const SOURCE_LABEL: Record<string, string> = { modrinth: 'Modrinth', curseforge: 'CurseForge' };

	type Hit = { id: string; name: string; author: string | null; summary: string | null; iconUrl: string | null; downloads: number | null; projectUrl: string | null };
	type File = { id: string; name: string; channel: string; date: string | null; url: string | null; sha1: string | null; size: number | null };

	const downloads = (n: number | null) =>
		n === null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M downloads` : n >= 1e3 ? `${Math.round(n / 1e3)}k downloads` : `${n} downloads`;
	const usable = (f: File) => !!f.url && !!f.sha1;

	async function getJson<T>(url: string): Promise<T> {
		const res = await fetch(url);
		const body = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(body.message ?? 'That did not work.');
		return body as T;
	}

	// ---- a newer version of the pack players are offered
	let newer = $state<File | null>(null);
	const catalogKey = $derived(pack.catalog ? `${pack.catalog.source}:${pack.catalog.projectId}:${pack.catalog.fileId}` : '');
	$effect(() => {
		const key = catalogKey;
		newer = null;
		if (!key || !canEdit) return;
		const current = untrack(() => pack.catalog!);
		let cancelled = false;
		getJson<{ files: File[] }>(`/api/resourcepacks/files?${new URLSearchParams({ source: current.source, id: current.projectId, mc: minecraftVersion })}`)
			.then(({ files }) => {
				const at = files.findIndex((f) => f.id === current.fileId);
				const first = files.find(usable);
				// Newest first: a usable file listed above the one in use.
				if (!cancelled && first && first.id !== current.fileId && (at < 0 || files.indexOf(first) < at)) newer = first;
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	});

	// ---- options (1.17+): bound to local state, re-synced when the saved values change. Through
	// $derived values, not `pack` itself: a running or paused server's page reloads its data every
	// few seconds, each time with a new `pack`, and that put the saved message back over the typing.
	const savedRequired = $derived(pack.required ?? false);
	const savedPrompt = $derived(pack.prompt ?? '');
	let required = $state(false);
	let prompt = $state('');
	$effect(() => {
		required = savedRequired;
	});
	$effect(() => {
		prompt = savedPrompt;
	});
	const optionsChanged = $derived(required !== savedRequired || prompt !== savedPrompt);

	// ---- browsing
	let hits = $state<Hit[]>([]);
	let note = $state('');
	let searchError = $state('');
	let page = 1;
	let moreHits = $state(false);
	let loadingMore = $state(false);
	let lastQuery = '';
	let selected = $state<Hit | null>(null);
	let files = $state<File[]>([]);
	let filesError = $state('');
	let loadingFiles = $state(false);
	let fileId = $state('');

	const query = () => new URLSearchParams({ source, term: term.trim(), mc: minecraftVersion });

	let run = 0;
	export async function search(fresh = false) {
		const mine = ++run;
		searching = true;
		searchError = '';
		selected = null;
		page = 1;
		lastQuery = query().toString();
		try {
			const body = await getJson<{ hits: Hit[]; note: string | null }>(`/api/resourcepacks/search?${lastQuery}${fresh ? '&fresh=1' : ''}`);
			if (mine !== run) return;
			hits = body.hits;
			note = body.note ?? '';
			moreHits = hits.length > 0;
			if (!hits.length && !note) searchError = 'Nothing matched. Try other words.';
		} catch (err) {
			if (mine === run) {
				hits = [];
				searchError = err instanceof Error ? err.message : 'Search failed.';
			}
		} finally {
			if (mine === run) searching = false;
		}
	}

	async function loadMore() {
		loadingMore = true;
		try {
			const asked = lastQuery;
			const params = new URLSearchParams(asked);
			params.set('page', String(page + 1));
			const body = await getJson<{ hits: Hit[] }>(`/api/resourcepacks/search?${params}`);
			if (asked !== lastQuery) return;
			const known = new Set(hits.map((h) => h.id));
			const fresh = body.hits.filter((h) => !known.has(h.id));
			page += 1;
			hits = [...hits, ...fresh];
			moreHits = fresh.length > 0;
		} catch (err) {
			searchError = err instanceof Error ? err.message : 'Could not load more.';
		} finally {
			loadingMore = false;
		}
	}

	// Opening the tab shows the most downloaded packs; typing or another catalog searches by itself.
	$effect(() => {
		if (active && canEdit && !hits.length && !untrack(() => searching || searchError || note)) void untrack(() => search());
	});
	$effect(() => {
		const asked = query().toString();
		if (!active || !canEdit || asked === lastQuery) return;
		const timer = setTimeout(() => asked !== lastQuery && void search(), SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	});

	async function choose(hit: Hit) {
		selected = hit;
		files = [];
		fileId = '';
		filesError = '';
		loadingFiles = true;
		try {
			const body = await getJson<{ files: File[] }>(`/api/resourcepacks/files?${new URLSearchParams({ source, id: hit.id, mc: minecraftVersion })}`);
			if (selected?.id !== hit.id) return;
			files = body.files;
			fileId = files.find(usable)?.id ?? '';
		} catch (err) {
			filesError = err instanceof Error ? err.message : 'Could not list the files.';
		} finally {
			loadingFiles = false;
		}
	}

	let url = $state('');
	let saving = $state('');
	const saveEnhance = (which: string) => () => {
		saving = which;
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			saving = '';
		};
	};
	let confirmRemove = $state(false);
</script>

{#if active}
	{#if !pack.supported}
		<div class="notice info"><p>Minecraft {minecraftVersion} has no server resource pack: it came with 1.7.10 (1.6 had texture packs, which MineShell does not set).</p></div>
	{:else}
		{#if toApply}
			<div class="notice warning">
				<p>Changed since the server started: it reads the resource pack only when it starts. Restart it for players to get this.</p>
			</div>
		{:else if running}
			<div class="notice info"><p>The server reads the resource pack when it starts: a change here reaches players after a restart.</p></div>
		{/if}
		<section class="current">
			<h2>Offered to players</h2>
			{#if pack.catalog}
				<div class="pack">
					{#if pack.catalog.iconUrl}<img src={pack.catalog.iconUrl} alt="" width="48" height="48" />{:else}<span class="icon-fallback" aria-hidden="true"></span>{/if}
					<div class="pack-body">
						<strong>
							{#if pack.catalog.projectUrl}<a href={pack.catalog.projectUrl} target="_blank" rel="noopener noreferrer">{pack.catalog.name}</a>{:else}{pack.catalog.name}{/if}
						</strong>
						<span class="small muted">{pack.catalog.version} · from {SOURCE_LABEL[pack.catalog.source]}</span>
						{#if newer}
							<form method="POST" action="?/resourcePack" use:enhance={saveEnhance('newer')} class="newer">
								<input type="hidden" name="source" value={pack.catalog.source} />
								<input type="hidden" name="projectId" value={pack.catalog.projectId} />
								<input type="hidden" name="fileId" value={newer.id} />
								<span class="small">A newer version is out: <span class="mono">{newer.name}</span></span>
								<button type="submit" class="small" disabled={!!saving}>{saving === 'newer' ? 'Changing' : 'Offer it instead'}</button>
							</form>
						{/if}
					</div>
				</div>
			{:else if pack.url}
				<div class="pack">
					<span class="icon-fallback" aria-hidden="true"></span>
					<div class="pack-body">
						<strong>A pack at an address</strong>
						<a class="small mono address" href={pack.url} target="_blank" rel="noopener noreferrer">{pack.url}</a>
						{#if !pack.sha1 && pack.takesSha1}
							<span class="small warn-text">No SHA-1 is set: players' games cannot tell when the pack changes. Set it again below to have MineShell work it out.</span>
						{/if}
					</div>
				</div>
			{:else}
				<p class="muted">None: players join with their own resource packs only.</p>
			{/if}
			{#if pack.url && canEdit}
				{#if confirmRemove}
					<form method="POST" action="?/resourcePackRemove" use:enhance={saveEnhance('remove')} class="confirm" use:reveal>
						<span class="small">Stop offering this pack? Players who have it keep it until they leave.</span>
						<button type="submit" class="danger small" disabled={!!saving}>{saving === 'remove' ? 'Removing' : 'Stop offering it'}</button>
						<button type="button" class="button-quiet small" onclick={() => (confirmRemove = false)}>Cancel</button>
					</form>
				{:else}
					<button type="button" class="button-quiet small" onclick={() => (confirmRemove = true)}>Stop offering it</button>
				{/if}
			{/if}
		</section>

		{#if pack.required !== null && pack.url && canEdit}
			<form method="POST" action="?/resourcePackOptions" use:enhance={saveEnhance('options')} class="options">
				<label class="check">
					<input type="checkbox" name="required" bind:checked={required} />
					<span>Players must take the pack: those who turn it down are disconnected.</span>
				</label>
				<label class="field" for="resource-pack-prompt">
					<span id="resource-pack-prompt-label"
						>A message under the game's question <span class="faint small">(optional: the game always asks its own)</span></span
					>
				</label>
				<FormattedTextInput id="resource-pack-prompt" name="prompt" hex bind:value={prompt} labelledby="resource-pack-prompt-label" />
				<ResourcePackPromptPreview {prompt} {required} {menuBlur} />
				<div class="row">
					<button type="submit" disabled={!optionsChanged || !!saving}>{saving === 'options' ? 'Saving' : 'Save'}</button>
				</div>
			</form>
		{/if}

		{#if canEdit}
			<section class="pick">
				<h2>Pick a pack</h2>
				<p class="small muted">
					Players' games download it from {SOURCE_LABEL[source]} when they join; MineShell sets the address and the SHA-1 the
					catalog gives, and keeps no copy. Packs for Minecraft {minecraftVersion}.
				</p>
				<div class="browse-bar">
					<div class="segmented" role="group" aria-label="Catalog">
						{#each SOURCES as s (s.id)}
							<button type="button" aria-pressed={source === s.id} onclick={() => (source = s.id)}>{s.label}</button>
						{/each}
					</div>
					<span class="faint small">A project ID from its page finds one the search misses.</span>
				</div>
				{#if note}<p class="notice info">{note}</p>{/if}
				{#if searchError}<p class="notice warning">{searchError}</p>{/if}

				{#if !note}
				<div class="browse">
					<ul class="hits" use:fitToViewport={{ bottomMarginPx: 24 }}>
						{#each hits as hit (hit.id)}
							<li>
								<button type="button" class="hit" aria-pressed={selected?.id === hit.id} onclick={() => choose(hit)}>
									{#if hit.iconUrl}<img src={hit.iconUrl} alt="" width="40" height="40" loading="lazy" />{:else}<span class="icon-fallback" aria-hidden="true"></span>{/if}
									<span class="hit-body">
										<span class="hit-title">
											<strong>{hit.name}</strong>
											<span class="faint small">{downloads(hit.downloads)}</span>
										</span>
										<span class="small muted summary">{hit.summary ?? ''}</span>
										{#if pack.catalog?.projectId === hit.id && pack.catalog.source === source}<span class="hit-tags"><span class="tag accent">offered</span></span>{/if}
									</span>
								</button>
							</li>
						{:else}
							<li class="faint small hits-empty">{searching ? 'Searching.' : note ? '' : 'No packs to show yet.'}</li>
						{/each}
						{#if hits.length && moreHits}
							<li class="more-hits">
								<button type="button" class="button-quiet" onclick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading' : 'Load more'}</button>
							</li>
						{/if}
					</ul>

					{#if selected}
						<div class="detail pane">
							<div class="detail-head">
								{#if selected.iconUrl}<img src={selected.iconUrl} alt="" width="48" height="48" />{:else}<span class="icon-fallback" aria-hidden="true"></span>{/if}
								<div class="pack-body">
									<strong>{selected.name}</strong>
									<span class="small muted">{selected.author ? `by ${selected.author} · ` : ''}{downloads(selected.downloads)}</span>
									{#if selected.projectUrl}<a class="small" href={selected.projectUrl} target="_blank" rel="noopener noreferrer">Its page on {SOURCE_LABEL[source]}</a>{/if}
								</div>
							</div>
							{#if selected.summary}<p class="small">{selected.summary}</p>{/if}
							{#if loadingFiles}
								<p class="muted small">Loading versions.</p>
							{:else if filesError}
								<p class="notice warning">{filesError}</p>
							{:else if !files.length}
								<p class="muted small">No versions of this pack for Minecraft {minecraftVersion}.</p>
							{:else}
								{#if !files.some(usable)}
									<p class="notice info">
										{SOURCE_LABEL[source]} gives no download for this pack: its author keeps it to their own site, so players cannot be
										pointed at it. Download it there and host it yourself, then give its address below.
									</p>
								{/if}
								<form method="POST" action="?/resourcePack" use:enhance={saveEnhance('pick')}>
									<input type="hidden" name="source" value={source} />
									<input type="hidden" name="projectId" value={selected.id} />
									<ul class="version-list">
										{#each files as f (f.id)}
											<li>
												<label class="version" class:picked={fileId === f.id} class:unusable={!usable(f)}>
													<input type="radio" name="fileId" value={f.id} bind:group={fileId} disabled={!usable(f)} />
													<span class="version-name">
														<span class="mono">{f.name}</span>
														{#if f.channel !== 'release'}<span class="tag warn">{f.channel}</span>{/if}
														{#if pack.catalog?.fileId === f.id}<span class="tag accent">offered</span>{/if}
													</span>
													<span class="faint small">
														{#if !f.url}no download{:else if !f.sha1}no SHA-1{:else}{f.size ? formatBytes(f.size) : ''}{f.date ? ` · ${formatDateTime(Date.parse(f.date))}` : ''}{/if}
													</span>
												</label>
											</li>
										{/each}
									</ul>
									<div class="row">
										<button type="submit" disabled={!fileId || !!saving || pack.catalog?.fileId === fileId}>
											{saving === 'pick' ? 'Setting' : pack.url ? 'Offer this one instead' : 'Offer this pack'}
										</button>
									</div>
								</form>
							{/if}
						</div>
					{/if}
				</div>
				{/if}
			</section>

			<section class="by-address">
				<h2>Or an address</h2>
				<p class="small muted">
					A pack on another site or your own web space: a direct link to the .zip that players' games can download. MineShell
					downloads it once to work out its SHA-1 (up to 250 MB), and again when you set it after changing the file.
				</p>
				<form method="POST" action="?/resourcePackUrl" use:enhance={saveEnhance('url')} class="row">
					<input type="text" inputmode="url" name="url" autocomplete="off" placeholder="https://example.com/pack.zip" bind:value={url} aria-label="The pack's address" />
					<button type="submit" disabled={!url.trim() || !!saving}>{saving === 'url' ? 'Downloading' : 'Offer it'}</button>
				</form>
			</section>
		{/if}
	{/if}
{/if}

<style>
	section,
	.options {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin-bottom: var(--space-5);
		min-width: 0;
	}
	h2 {
		margin: 0;
		font-size: 1rem;
	}
	.pack,
	.detail-head {
		display: flex;
		gap: var(--space-3);
		align-items: flex-start;
		min-width: 0;
	}
	.pack img,
	.detail-head img,
	.hit img,
	.icon-fallback {
		width: 40px;
		height: 40px;
		flex: 0 0 40px;
		border-radius: var(--radius);
		background: var(--panel-raised);
		object-fit: cover;
	}
	.pack img,
	.pack .icon-fallback,
	.detail-head img,
	.detail-head .icon-fallback {
		width: 48px;
		height: 48px;
		flex-basis: 48px;
	}
	.pack-body {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}
	.address {
		overflow-wrap: anywhere;
	}
	.current > button {
		align-self: flex-start;
	}
	.newer,
	.confirm,
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.newer {
		margin-top: var(--space-1);
	}
	.row input[name='url'] {
		flex: 1 1 16rem;
		max-width: 36rem;
		margin: 0;
	}
	.check {
		display: flex;
		gap: var(--space-2);
		align-items: flex-start;
	}
	.field {
		margin: 0;
	}
	.browse-bar {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.segmented {
		display: inline-flex;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.segmented button {
		border: 0;
		border-radius: 0;
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
	.more-hits button {
		width: 100%;
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
		min-width: 0;
	}
	.hit-title strong {
		font-weight: 500;
		min-width: 0;
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
		gap: var(--space-2);
		min-width: 0;
	}
	.version-list {
		list-style: none;
		margin: 0 0 var(--space-2);
		padding: 0;
		max-height: 24rem;
		overflow-y: auto;
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
		flex-wrap: wrap;
	}
	.version.picked {
		background: var(--panel-raised);
	}
	.version.unusable {
		cursor: default;
		opacity: 0.6;
	}
	.version-name {
		flex: 1;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		overflow-wrap: anywhere;
	}
	@media (max-width: 70rem) {
		.browse {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
