<script lang="ts">
	import { can, mayCancelTask, type InstancePermission } from '#lib/shared/access.js';
	import { enhance } from '#lib/shared/forms.js';
	import { dropzone } from '#lib/shared/dropzone.js';
	import { refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import Flash from '#lib/components/Flash.svelte';
	import SnapshotChoice from '#lib/components/SnapshotChoice.svelte';
	import SegmentedChoice from '#lib/components/SegmentedChoice.svelte';
	import RowMenu from '#lib/components/RowMenu.svelte';
	import PruneMap from '#lib/components/PruneMap.svelte';
	import PregenPlanner from '#lib/components/PregenPlanner.svelte';
	import { formatBytes, formatDateTime, formatRelative } from '#lib/shared/format.js';

	let { data, form } = $props();
	/** What this account may do here; the server checks every action again. */
	const may = (permission: InstancePermission) => can(data.access, data.instance.id, permission);

	const base = $derived(`/api/instances/${encodeURIComponent(data.instance.id)}/world`);
	const busy = $derived(data.instance.status === 'provisioning');

	const VIEWS = ['snapshots', 'worlds', 'pregen', 'prune', 'reset'] as const;
	// ?view= opens a tab: Restore chunks is a page of its own and links back to the others.
	const asked = page.url.searchParams.get('view');
	let view = $state<(typeof VIEWS)[number]>(VIEWS.find((v) => v === asked) ?? 'snapshots');
	let pendingRestore = $state<string | null>(null);
	let pendingDelete = $state<string | null>(null);
	let pendingEdit = $state<string | null>(null);
	let pendingNewWorld = $state<string | null>(null);
	/** Opens one confirm/edit row under a snapshot, closing the others; again on the same one closes it. */
	function openRow(kind: 'restore' | 'delete' | 'edit' | 'world', id: string) {
		const open = { restore: pendingRestore, delete: pendingDelete, edit: pendingEdit, world: pendingNewWorld }[kind] !== id;
		pendingRestore = open && kind === 'restore' ? id : null;
		pendingDelete = open && kind === 'delete' ? id : null;
		pendingEdit = open && kind === 'edit' ? id : null;
		pendingNewWorld = open && kind === 'world' ? id : null;
	}
	/** A world's name by its folder; a deleted world's folder stays its name. */
	const worldName = (folder: string) => data.serverWorlds.find((w) => w.folder === folder)?.name ?? folder;
	// Snapshots are listed per world, the active one first.
	let snapshotWorld = $state<string | null>(null);
	const snapshotWorlds = $derived(
		[data.levelName, ...new Set(data.snapshots.map((s) => s.worldFolder).filter((f) => f !== data.levelName))]
	);
	const shownWorld = $derived(snapshotWorld && snapshotWorlds.includes(snapshotWorld) ? snapshotWorld : data.levelName);
	const worldSnapshots = $derived(data.snapshots.filter((s) => s.worldFolder === shownWorld));
	// The user's tags, to show only the snapshots with one.
	let tagFilter = $state<string | null>(null);
	const allTags = $derived(
		[...new Set(worldSnapshots.flatMap((s) => s.tags ?? []))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
	);
	// Snapshots with a copy in the server's backup folder.
	const copied = $derived(
		new Set(data.backups && data.backups.fromServer === data.instance.id ? data.backups.copies.map((c) => c.id) : [])
	);
	const onlyThere = $derived(data.backups ? data.backups.copies.filter((c) => !c.onServer) : []);
	const otherServers = $derived(data.backups ? data.backups.servers.filter((id) => id !== data.instance.id) : []);
	const shownSnapshots = $derived(
		tagFilter && allTags.includes(tagFilter) ? worldSnapshots.filter((s) => s.tags?.includes(tagFilter!)) : worldSnapshots
	);

	// ---- worlds
	let pendingWorld = $state<{ kind: 'switch' | 'rename' | 'delete'; folder: string } | null>(null);
	function openWorldRow(kind: 'switch' | 'rename' | 'delete', folder: string) {
		pendingWorld = pendingWorld?.kind === kind && pendingWorld.folder === folder ? null : { kind, folder };
	}
	const activeWorld = $derived(data.serverWorlds.find((w) => w.active));
	let newWorldSeed = $state<'random' | 'set'>('random');
	const closeWorldRow = () => async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
		pendingWorld = null;
		await update();
	};
	let seedMode = $state<'keep' | 'random' | 'set'>('keep');

	// ---- Chunky pre-generation
	const clock = (seconds: number) =>
		`${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
	// Progress moves on its own while a task runs; nothing else on this page does.
	$effect(() => {
		if (!data.chunky?.status?.running.length) return;
		const timer = setInterval(() => void refreshAll(), 5000);
		return () => clearInterval(timer);
	});
	const confirmCancel = (world: string) => ({ cancel }: { cancel: () => void }) => {
		if (!confirm(`Cancel pre-generating ${world}? A cancelled task cannot be continued.`)) cancel();
	};

	// Uploads go straight to the endpoint (not a form action), which takes the
	// raw file so a big world is never held in memory; XHR for the progress.
	let uploadPercent = $state<number | null>(null);
	let uploadMessage = $state('');
	let uploadError = $state('');

	/** Sends a world zip to the endpoint; resolves with the answer's message, or the error's. */
	function putWorld(file: File, params: URLSearchParams, onProgress: (percent: number) => void): Promise<{ ok: boolean; message?: string }> {
		return new Promise((resolve) => {
			const xhr = new XMLHttpRequest();
			xhr.open('PUT', `${base}?${params}`);
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
			};
			xhr.onload = () => {
				const body = (() => {
					try {
						return JSON.parse(xhr.responseText);
					} catch {
						return {};
					}
				})();
				if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true });
				else
					resolve({
						ok: false,
						message:
							body.message ??
							(xhr.status === 413 ? 'The file is bigger than this MineShell accepts (BODY_SIZE_LIMIT).' : 'The upload failed.')
					});
			};
			xhr.onerror = () => resolve({ ok: false, message: 'The upload failed.' });
			xhr.send(file);
		});
	}

	async function uploadWorld(event: SubmitEvent) {
		event.preventDefault();
		const formEl = event.currentTarget as HTMLFormElement;
		const fields = new FormData(formEl);
		const file = fields.get('world');
		if (!(file instanceof File) || !file.size) {
			uploadError = 'Choose a zip first.';
			return;
		}
		if (!confirm(`Replace the world of ${data.instance.name} with ${file.name}?`)) return;
		const params = new URLSearchParams();
		const snapshot = fields.get('snapshot');
		if (snapshot) params.set('snapshot', String(snapshot));
		uploadError = '';
		uploadMessage = '';
		uploadPercent = 0;
		const result = await putWorld(file, params, (p) => (uploadPercent = p));
		uploadPercent = null;
		if (result.ok) {
			uploadMessage = 'Uploaded. Replacing the world; follow it in Activity.';
			formEl.reset();
			void refreshAll();
		} else uploadError = result.message ?? 'The upload failed.';
	}

	// An upload that becomes a new world beside the others (Worlds).
	let newUploadPercent = $state<number | null>(null);
	let newUploadMessage = $state('');
	let newUploadError = $state('');
	let uploadActivate = $state(false);

	async function uploadNewWorld(event: SubmitEvent) {
		event.preventDefault();
		const formEl = event.currentTarget as HTMLFormElement;
		const fields = new FormData(formEl);
		const file = fields.get('world');
		const name = String(fields.get('name') ?? '').trim();
		if (!(file instanceof File) || !file.size) {
			newUploadError = 'Choose a zip first.';
			return;
		}
		newUploadError = '';
		newUploadMessage = '';
		newUploadPercent = 0;
		const params = new URLSearchParams({ newWorld: name || file.name.replace(/\.zip$/i, '') });
		const activate = fields.get('activate') === 'on';
		if (activate) params.set('activate', '1');
		if (fields.get('keepMap') === 'on') params.set('keepMap', '1');
		const result = await putWorld(file, params, (p) => (newUploadPercent = p));
		newUploadPercent = null;
		if (result.ok) {
			newUploadMessage = activate
				? 'Uploaded. Unpacking it; it becomes the active world when the task finishes.'
				: 'Uploaded. Unpacking it as a new world; it shows here when the task finishes.';
			uploadActivate = false;
			formEl.reset();
			void refreshAll();
		} else newUploadError = result.message ?? 'The upload failed.';
	}

	/** What a snapshot row shows, for this server's snapshots and the copies in its backup folder alike. */
	type SnapshotRow = {
		createdAt: number;
		label: string;
		note?: string;
		pinned?: boolean;
		partial?: boolean;
		tags?: string[];
		worlds: string[];
		sizeBytes: number;
		minecraftVersion: string;
		modloader: string;
		modloaderVersion: string | null;
		packVersionName: string | null;
	};

	function differs(s: SnapshotRow) {
		return (
			s.minecraftVersion !== data.current.minecraftVersion ||
			s.modloader !== data.current.modloader ||
			s.modloaderVersion !== data.current.modloaderVersion
		);
	}
</script>

<!-- One snapshot as a row shows it: what it is on the first line, when, how big and what it ran on under it. -->
{#snippet snapshotSummary(s: SnapshotRow, backedUp: boolean)}
	<div class="snap-name">
		{#if s.note}<strong>{s.note}</strong>{:else}{s.label}{/if}
		{#if s.pinned}<span class="tag accent">pinned</span>{/if}
		{#if s.partial}<span class="tag">part of the world</span>{/if}
		{#each s.tags ?? [] as tag (tag)}<span class="tag">{tag}</span>{/each}
	</div>
	<div class="snap-meta small">
		{#if s.note}<span class="muted">{s.label}</span>{/if}
		<span title={formatRelative(s.createdAt)}>{formatDateTime(s.createdAt)}</span>
		<span class="faint">{formatRelative(s.createdAt)}</span>
		<span class="mono">{formatBytes(s.sizeBytes)}</span>
		{#if s.packVersionName && s.packVersionName !== data.current.packVersionName}<span>pack {s.packVersionName}</span>{/if}
		{#if differs(s)}
			<span class="warn-text" title="What the world last ran on; the server now runs {data.current.minecraftVersion}, {data.current.modloader}{data.current.modloaderVersion ? ` ${data.current.modloaderVersion}` : ''}"
				>ran on {s.minecraftVersion}, {s.modloader}{s.modloaderVersion ? ` ${s.modloaderVersion}` : ''}</span
			>
		{/if}
		{#if backedUp}<span title="A copy is in {data.backups?.destination.name}">backed up</span>{/if}
		{#if s.partial}<span class="mono">{s.worlds.length > 3 ? `${s.worlds.length} files` : s.worlds.join(', ')}</span>{/if}
	</div>
{/snippet}

<div class="subhead">
	<nav class="subtabs" aria-label="World sections">
		{#each ([['snapshots', 'Snapshots'], ['worlds', 'Worlds'], ['pregen', 'Pre-generate'], ['prune', 'Prune chunks'], ['reset', 'Replace or reset']] as const).filter(([id]) => id === 'snapshots' || id === 'worlds' || may('world')) as [id, label] (id)}
			<button type="button" aria-current={view === id ? 'page' : undefined} onclick={() => (view = id)}>{label}</button>
		{/each}
		{#if may('backups.restore')}
			<a href="/instances/{encodeURIComponent(data.instance.id)}/world/chunks">Restore chunks</a>
		{/if}
	</nav>
</div>

<Flash {form} />

{#if view === 'snapshots'}
<dl class="strip">
	<div>
		<dt>World size</dt>
		<dd class="mono">{data.worlds.length ? formatBytes(data.snapshotPrompt.worldBytes) : '-'}</dd>
	</div>
	<div>
		<dt>Dimensions</dt>
		<dd class="mono">{data.dimensions.length || '-'}</dd>
	</div>
	<div>
		<dt>Seed</dt>
		<dd class="mono seed-value">{data.worldSeed ?? (data.seed || 'random')}</dd>
		{#if data.worldSeed && !data.seed}<dd class="sub">picked at random</dd>{/if}
	</div>
	<div>
		<dt>Snapshots</dt>
		<dd class="mono" title="On disk: files that did not change between snapshots are kept once">
			{data.snapshots.length}{data.snapshots.length ? ` · ${formatBytes(data.snapshotDiskBytes)}` : ''}
		</dd>
	</div>
</dl>

<section class="view">
	<div class="section-head">
		<div>
			<h2>Snapshots</h2>
			<p>
				{#if data.worlds.length}
					Of <code>{data.worlds.join(', ')}</code>, taken before risky operations and on request.
				{:else}
					No world yet; the server creates <code>{data.levelName}</code> on its first start.
				{/if}
				At least the newest {data.snapshotPrompt.policy.keepMin} full and {data.snapshotPrompt.policy.partialMin} partial
				ones are kept, more while they fit in {formatBytes(data.snapshotPrompt.policy.budgetMb * 1024 * 1024)}{#if may('settings.view')}{' '}
					(<a href="/instances/{encodeURIComponent(data.instance.id)}/settings?tab=snapshots">Settings</a>){/if}, plus any pinned. Restoring keeps
				the current world as a snapshot first, unless you choose otherwise.
			</p>
		</div>
		{#if data.worlds.length}
			<div class="button-row">
				<!-- A world zip holds every player's data: file access. -->
				{#if may('files')}<a class="button" href={base} download>Download as zip</a>{/if}
				{#if may('backups.create')}
					<form method="POST" action="?/snapshot" use:enhance>
						<button type="submit" disabled={busy} title={data.running ? 'Saving pauses for the copy, as for scheduled snapshots' : undefined}>Snapshot now</button>
					</form>
				{/if}
			</div>
		{/if}
	</div>

	{#if data.snapshots.length === 0}
		<div class="empty"><p>No snapshots yet.</p></div>
	{:else}
		{#if snapshotWorlds.length > 1}
			<div class="chips tag-filter" role="group" aria-label="Show snapshots of">
				{#each snapshotWorlds as folder (folder)}
					<button type="button" class="chip" aria-pressed={shownWorld === folder} onclick={() => (snapshotWorld = folder)}>
						{worldName(folder)}{folder === data.levelName ? ' (active)' : ''}<span class="count"
							>{data.snapshots.filter((s) => s.worldFolder === folder).length}</span
						>
					</button>
				{/each}
			</div>
			{#if shownWorld !== data.levelName}
				<p class="hint">
					Snapshots of a world that is not active restore once it is active again (Worlds), or become a new world of
					their own. They count towards this server's snapshot limits like the others, so newer snapshots can push them
					out: pin the ones to keep.
				</p>
			{/if}
		{/if}
		{#if allTags.length}
			<div class="chips tag-filter" role="group" aria-label="Show snapshots tagged">
				<button type="button" class="chip" aria-pressed={!tagFilter || !allTags.includes(tagFilter)} onclick={() => (tagFilter = null)}>
					All<span class="count">{data.snapshots.length}</span>
				</button>
				{#each allTags as tag (tag)}
					<button type="button" class="chip" aria-pressed={tagFilter === tag} onclick={() => (tagFilter = tagFilter === tag ? null : tag)}>
						{tag}<span class="count">{data.snapshots.filter((s) => s.tags?.includes(tag)).length}</span>
					</button>
				{/each}
			</div>
		{/if}
		{#if worldSnapshots.length === 0}
			<div class="empty"><p>No snapshots of this world yet.</p></div>
		{:else}
		<div class="table-box">
		<table class="snapshot-table">
			<thead class="visually-hidden">
				<tr>
					<th>Snapshot</th>
					<th>Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each shownSnapshots as s (s.id)}
					<tr>
						<td>{@render snapshotSummary(s, copied.has(s.id))}</td>
						<td class="actions-cell">
							<div class="row-actions">
								<!-- Unpinning lets retention delete it: that takes snapshot deletion. -->
								{#if s.pinned ? may('backups.delete') : may('backups.create')}
									<form method="POST" action="?/pinSnapshot" use:enhance>
										<input type="hidden" name="id" value={s.id} />
										<input type="hidden" name="pinned" value={String(!s.pinned)} />
										<button
											type="submit"
											class="button-quiet"
											title={s.pinned ? 'Let it be deleted to make room again' : 'Keep it until unpinned; it does not count towards the limit'}
										>
											{s.pinned ? 'Unpin' : 'Pin'}
										</button>
									</form>
								{/if}
								{#if may('backups.create')}
									<button type="button" class="button-quiet wide-only" title="Name and tags" onclick={() => openRow('edit', s.id)}>Edit</button>
								{/if}
								{#if may('backups.restore')}
									<button
										type="button"
										class="button-quiet"
										disabled={data.running || busy || !s.ofThisWorld}
										title={s.ofThisWorld ? undefined : `Of ${worldName(s.worldFolder)}, which is not the active world: switch to it under Worlds to restore this.`}
										onclick={() => openRow('restore', s.id)}>Restore</button
									>
								{/if}
								{#if may('backups.delete')}
									<button type="button" class="button-quiet wide-only" disabled={busy} onclick={() => openRow('delete', s.id)}>Delete</button>
								{/if}
								<!-- The rarer actions; in narrow windows Edit and Delete too. -->
								{#if may('files') || (may('world') && !s.partial) || may('backups.create') || may('backups.delete')}
									<RowMenu>
										{#snippet children(close)}
											{#if may('backups.create')}
												<button type="button" role="menuitem" class="narrow-only" onclick={() => (openRow('edit', s.id), close())}>Edit name and tags</button>
											{/if}
											{#if may('files')}
												<a role="menuitem" href="{base}?snapshot={encodeURIComponent(s.id)}" download onclick={close}>Download as zip</a>
											{/if}
											{#if may('world') && !s.partial}
												<button type="button" role="menuitem" title="Copy it out as a world of its own, beside the others" onclick={() => (openRow('world', s.id), close())}
													>Make a new world of it</button
												>
											{/if}
											{#if may('backups.delete')}
												<button type="button" role="menuitem" class="narrow-only danger" disabled={busy} onclick={() => (openRow('delete', s.id), close())}>Delete</button>
											{/if}
										{/snippet}
									</RowMenu>
								{/if}
							</div>
						</td>
					</tr>
					{#if pendingRestore === s.id}
						<tr class="confirm-row">
							<td colspan="2">
								<form
									method="POST"
									action="?/restore"
									use:enhance={() => async ({ update }) => {
										pendingRestore = null;
										await update();
									}}
								>
									<input type="hidden" name="id" value={s.id} />
									{#if s.reason === 'world-restore-chunks'}
										<p>
											Puts back the {s.worlds.length} region file{s.worlds.length === 1 ? '' : 's'} a chunk restore changed, as they were on
											{formatDateTime(s.createdAt)}. The rest of the world stays as it is.
										</p>
									{:else if s.partial}
										<p>
											Puts back {s.dimensions.map((d) => d.label).join(', ') || s.worlds.join(', ')} as it was on
											{formatDateTime(s.createdAt)}. The rest of the world stays as it is.
										</p>
									{:else}
										<p>Replaces the current world with this snapshot from {formatDateTime(s.createdAt)}.</p>
										{#if s.dimensions.length > 1}
											<div class="field restore-scope">
												<label for="restore-dim-{s.id}">What to restore</label>
												<select id="restore-dim-{s.id}" name="dimension">
													<option value="">The whole world</option>
													{#each s.dimensions as d (d.key)}
														<option value={d.key}>Only {d.label}{d.overworld ? ' (terrain; players and world data stay)' : ''}</option>
													{/each}
												</select>
											</div>
										{/if}
									{/if}
									{#if differs(s)}
										<p class="warn-text small">
											This world last ran on Minecraft {s.minecraftVersion} with {s.modloader}
											{s.modloaderVersion ?? ''}; the server now runs {data.current.minecraftVersion} with
											{data.current.modloader} {data.current.modloaderVersion ?? ''}. If the mods or versions changed since,
											revert those too, or blocks and items from them may be lost.
										</p>
									{/if}
									<SnapshotChoice moves prompt={data.snapshotPrompt} idPrefix="restore-{s.id}" />
									<div class="button-row">
										<button class="button-primary" type="submit">Restore this snapshot</button>
										<button class="button-quiet" type="button" onclick={() => (pendingRestore = null)}>Cancel</button>
									</div>
								</form>
							</td>
						</tr>
					{:else if pendingNewWorld === s.id}
						<tr class="confirm-row">
							<td colspan="2">
								<form
									method="POST"
									action="?/worldFromSnapshot"
									class="snapshot-edit"
									use:enhance={() => async ({ result, update }) => {
										await update({ reset: false });
										if (result.type === 'success') pendingNewWorld = null;
									}}
								>
									<input type="hidden" name="id" value={s.id} />
									<div class="field">
										<label for="snap-world-{s.id}">Name of the new world</label>
										<input
											id="snap-world-{s.id}"
											name="name"
											maxlength="60"
											value="{worldName(s.worldFolder)}, {formatDateTime(s.createdAt)}"
										/>
										<p class="hint">Copied beside the other worlds, not active; switch to it under Worlds. The server may keep running.</p>
									</div>
									<div class="button-row">
										<button class="button-primary" type="submit">Make the world</button>
										<button class="button-quiet" type="button" onclick={() => (pendingNewWorld = null)}>Cancel</button>
									</div>
								</form>
							</td>
						</tr>
					{:else if pendingEdit === s.id}
						<tr class="confirm-row">
							<td colspan="2">
								<form
									method="POST"
									action="?/editSnapshot"
									class="snapshot-edit"
									use:enhance={() => async ({ result, update }) => {
										await update({ reset: false });
										if (result.type === 'success') pendingEdit = null;
									}}
								>
									<input type="hidden" name="id" value={s.id} />
									<div class="field">
										<label for="snap-note-{s.id}">Name</label>
										<input id="snap-note-{s.id}" name="note" maxlength="120" value={s.note ?? ''} placeholder={s.label} />
									</div>
									<div class="field">
										<label for="snap-tags-{s.id}">Tags</label>
										<input
											id="snap-tags-{s.id}"
											name="tags"
											value={(s.tags ?? []).join(', ')}
											placeholder="e.g. before boss fight, keep"
										/>
										<p class="hint">Separated by commas.</p>
									</div>
									<div class="button-row">
										<button class="button-primary" type="submit">Save</button>
										<button class="button-quiet" type="button" onclick={() => (pendingEdit = null)}>Cancel</button>
									</div>
								</form>
							</td>
						</tr>
					{:else if pendingDelete === s.id}
						<tr class="confirm-row">
							<td colspan="2">
								<form
									method="POST"
									action="?/deleteSnapshot"
									use:enhance={() => async ({ update }) => {
										pendingDelete = null;
										await update();
									}}
								>
									<input type="hidden" name="id" value={s.id} />
									<div class="button-row at-end">
										<span class="small">Delete this snapshot for good?</span>
										<button class="button-danger" type="submit">Yes, delete</button>
										<button class="button-quiet" type="button" onclick={() => (pendingDelete = null)}>Cancel</button>
									</div>
								</form>
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
		</div>
		{/if}
	{/if}
	{#if data.backups}
		{@const backups = data.backups}
		<div class="backup-copies">
			<h3>In the backup folder</h3>
			<p class="small muted">
				Copies in {backups.destination.name} (<code>{backups.destination.path}</code>), the newest {backups.setting.keep}
				and pinned ones. One that is no longer here copies back as a snapshot, to restore or to make a world of.
				{#if backups.last && !backups.last.ok && !backups.problem}
					<span class="bad-text">The last copy failed ({formatDateTime(backups.last.at)}): {backups.last.message}</span>
				{/if}
			</p>
			{#if backups.problem}
				<div class="notice warning"><p>{backups.problem}</p></div>
			{:else}
				{#if data.access.globalAdmin && (otherServers.length || backups.fromServer !== data.instance.id)}
					<form method="GET" class="inline-form">
						<input type="hidden" name="view" value="snapshots" />
						<div class="field">
							<label for="backups-of">Copies of</label>
							<select id="backups-of" name="backupsOf" value={backups.fromServer} onchange={(e) => e.currentTarget.form?.requestSubmit()}>
								<option value={data.instance.id}>this server</option>
								{#each otherServers as id (id)}<option value={id}>{id}</option>{/each}
							</select>
						</div>
						<noscript><button type="submit">Show</button></noscript>
					</form>
					{#if backups.fromServer !== data.instance.id}
						<p class="hint">
							Another server's copies, such as one deleted and made again: copied back here, they can become a world of
							this server (Use as a new world).
						</p>
					{/if}
				{/if}
				{#if !backups.copies.length}
					<div class="empty"><p>No copies there yet.</p></div>
				{:else if !onlyThere.length}
					<p class="small faint">{backups.copies.length} cop{backups.copies.length === 1 ? 'y' : 'ies'}, all of snapshots this server still has.</p>
				{:else}
					<div class="table-box">
						<table class="snapshot-table">
							<thead class="visually-hidden">
								<tr>
									<th>Copy</th>
									<th>Actions</th>
								</tr>
							</thead>
							<tbody>
								{#each onlyThere as c (c.id)}
									<tr>
										<td>{@render snapshotSummary(c, false)}</td>
										<td class="actions-cell">
											{#if may('backups.create')}
												<form method="POST" action="?/copyBack" use:enhance class="row-actions">
													<input type="hidden" name="id" value={c.id} />
													<input type="hidden" name="from" value={backups.fromServer} />
													<button type="submit" class="button-quiet" disabled={busy}>Copy back</button>
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
		</div>
	{/if}
	{#if data.running && data.worlds.length}
		<p class="faint small after">
			Stop the server to take or restore a snapshot. While it runs, a download pauses saving (<code>save-off</code>) until
			the zip is done.
		</p>
	{/if}
</section>
{:else if view === 'worlds'}
<section class="view">
	<div class="section-head">
		<div>
			<h2>Worlds</h2>
			<p>
				Each world is a folder in the server folder; the server loads the active one. Switching moves no world, so the
				others stay as they were, with their own seed and data packs. Snapshots are taken of the active world; those of the
				others wait under Snapshots until their world is active again, and share this server's snapshot limits, so pin the
				ones to keep.
			</p>
		</div>
	</div>

	<div class="table-box">
		<table>
			<thead>
				<tr>
					<th>World</th>
					<th class="nowrap">Ran on</th>
					<th class="nowrap">Size</th>
					<th class="nowrap">Snapshots</th>
					<th><span class="visually-hidden">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.serverWorlds as w (w.folder)}
					<tr>
						<td>
							<strong>{w.name}</strong>
							{#if w.active}<span class="tag accent">active</span>{/if}
							{#if !w.generated}<span class="tag" title="Not generated yet: the server makes it on its next start as the active world">new</span>{/if}
							{#if w.mapKept}<span class="tag">map kept</span>{/if}
							<div class="faint small mono">{w.folders.join(', ') || w.folder}</div>
						</td>
						<td class="small nowrap" class:warn-text={!!w.newer || !!w.otherLoader}>
							{#if w.active}
								{data.current.minecraftVersion}, {data.current.modloader}
							{:else if w.lastRun}
								{w.version ?? w.lastRun.minecraftVersion}, {w.lastRun.modloader}{w.lastRun.modloaderVersion ? ` ${w.lastRun.modloaderVersion}` : ''}
								{#if w.lastRun.packVersionName}<div class="faint">{w.lastRun.packVersionName}</div>{/if}
							{:else}
								{w.version ?? '-'}
							{/if}
							{#if w.leftAt}<div class="faint">left {formatRelative(w.leftAt)}</div>{/if}
						</td>
						<td class="mono small nowrap" title={w.active ? undefined : 'Measured when it was last active: an inactive world does not change'}>
							{w.active ? (w.generated ? formatBytes(data.snapshotPrompt.worldBytes) : '-') : w.sizeBytes ? formatBytes(w.sizeBytes) : '-'}
						</td>
						<td class="mono small">{w.snapshots || '-'}</td>
						<td>
							<div class="row-actions">
								{#if may('world') && !w.active}
									<button type="button" class="button-quiet" disabled={data.running || busy} onclick={() => openWorldRow('switch', w.folder)}>
										Switch to
									</button>
								{/if}
								{#if may('world')}
									<button type="button" class="button-quiet" onclick={() => openWorldRow('rename', w.folder)}>Rename</button>
								{/if}
								{#if may('files') && w.folders.length}
									<a class="button button-quiet" href="{base}{w.active ? '' : `?world=${encodeURIComponent(w.folder)}`}" download>Download</a>
								{/if}
								{#if may('world') && !w.active}
									<button type="button" class="button-quiet" disabled={busy} onclick={() => openWorldRow('delete', w.folder)}>Delete</button>
								{/if}
							</div>
						</td>
					</tr>
					{#if pendingWorld?.folder === w.folder && pendingWorld.kind === 'switch'}
						<tr class="confirm-row">
							<td colspan="2">
								<form method="POST" action="?/switchWorld" use:enhance={closeWorldRow}>
									<input type="hidden" name="world" value={w.folder} />
									<p>
										Makes {w.name} the active world; the server loads it on its next start. {activeWorld?.name ?? data.levelName}
										stays as it is, to switch back to.
									</p>
									{#if w.otherLoader}<p class="warn-text small">{w.otherLoader}</p>{/if}
									{#if w.newer}
										<p class="warn-text small">{w.newer}</p>
										<div class="check">
											<input id="force-{w.folder}" type="checkbox" name="force" required />
											<label for="force-{w.folder}">Switch anyway: I know it may damage this world</label>
										</div>
									{/if}
									{#if data.packServer && !w.generated}
										<p class="small muted">Not generated yet: it starts with the data packs it was given when it was made.</p>
									{/if}
									{#if data.mapRendered}
										<div class="check">
											<input id="keep-map-{w.folder}" type="checkbox" name="keepMap" checked />
											<label for="keep-map-{w.folder}">Keep the map of {activeWorld?.name ?? data.levelName} for when it is active again</label>
										</div>
									{/if}
									{#if w.mapKept}<p class="small muted">Its own map is kept and shows on the Map tab again.</p>{/if}
									<div class="button-row">
										<button class="button-primary" type="submit">Switch to {w.name}</button>
										<button class="button-quiet" type="button" onclick={() => (pendingWorld = null)}>Cancel</button>
									</div>
								</form>
							</td>
						</tr>
					{:else if pendingWorld?.folder === w.folder && pendingWorld.kind === 'rename'}
						<tr class="confirm-row">
							<td colspan="2">
								<form
									method="POST"
									action="?/renameWorld"
									class="snapshot-edit"
									use:enhance={() => async ({ result, update }) => {
										await update({ reset: false });
										if (result.type === 'success') pendingWorld = null;
									}}
								>
									<input type="hidden" name="world" value={w.folder} />
									<div class="field">
										<label for="world-name-{w.folder}">Name</label>
										<input id="world-name-{w.folder}" name="name" maxlength="60" value={w.name} />
										<p class="hint">Its folder stays <code>{w.folder}</code>.</p>
									</div>
									<div class="button-row">
										<button class="button-primary" type="submit">Save</button>
										<button class="button-quiet" type="button" onclick={() => (pendingWorld = null)}>Cancel</button>
									</div>
								</form>
							</td>
						</tr>
					{:else if pendingWorld?.folder === w.folder && pendingWorld.kind === 'delete'}
						<tr class="confirm-row">
							<td colspan="2">
								<form method="POST" action="?/deleteWorld" use:enhance={closeWorldRow}>
									<input type="hidden" name="world" value={w.folder} />
									<p>Delete {w.name}? Its folders go to the trash, where Files can put them back until the trash is emptied.</p>
									{#if w.snapshots && may('backups.delete')}
										<div class="check">
											<input id="delete-snaps-{w.folder}" type="checkbox" name="snapshots" />
											<label for="delete-snaps-{w.folder}">Also delete its {w.snapshots} snapshot{w.snapshots === 1 ? '' : 's'} (pinned ones stay)</label>
										</div>
									{/if}
									<div class="button-row at-end">
										<button class="button-danger" type="submit">Yes, delete</button>
										<button class="button-quiet" type="button" onclick={() => (pendingWorld = null)}>Cancel</button>
									</div>
								</form>
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	</div>
</section>

{#if may('world')}
	<section class="panel new-world">
		<h2>New world</h2>
		<p class="muted">
			Starts a new world beside the others and makes it the active one; the server generates it on its next start, with the
			current level type and generator settings.
		</p>
		<form method="POST" action="?/createWorld" use:enhance={() => async ({ result, update }) => {
			await update({ reset: result.type === 'success' });
		}}>
			<div class="field restore-scope">
				<label for="new-world-name">Name</label>
				<input id="new-world-name" name="name" maxlength="60" required placeholder="e.g. Season 2" />
			</div>
			<div class="field">
				<span class="label" id="new-seed-label">Seed</span>
				<div class="seed-row">
					<SegmentedChoice
						options={[
							{ value: 'random', label: 'Random' },
							{ value: 'set', label: 'This seed' }
						]}
						bind:value={newWorldSeed}
						name="seedMode"
						labelledby="new-seed-label"
					/>
					{#if newWorldSeed === 'set'}<input name="seed" aria-label="Seed" placeholder="Seed" class="mono" />{/if}
				</div>
			</div>
			{#if data.datapackCount}
				<div class="check">
					<input id="copy-datapacks" type="checkbox" name="copyDatapacks" checked />
					<label for="copy-datapacks">Copy the {data.datapackCount} data pack{data.datapackCount === 1 ? '' : 's'} of {activeWorld?.name ?? data.levelName}</label>
				</div>
				<p class="hint">
					{data.packServer ? "The pack's data packs are among them; without them the new world has none of the pack's." : ''}
					World-generation data packs only shape a world generated with them.
				</p>
			{/if}
			{#if data.mapRendered}
				<div class="check">
					<input id="new-keep-map" type="checkbox" name="keepMap" checked />
					<label for="new-keep-map">Keep the map of {activeWorld?.name ?? data.levelName} for when it is active again</label>
				</div>
			{/if}
			{#if data.running}<p class="hint">Stop the server to start a new world.</p>{/if}
			<button class="button-primary" type="submit" disabled={data.running || busy}>Make it and switch to it</button>
		</form>
	</section>

	<section class="panel new-world" use:dropzone={{ disabled: newUploadPercent !== null, label: 'Drop the world zip here' }}>
		<h2>Upload a world</h2>
		<p class="muted">
			A zipped world, e.g. a singleplayer save, becomes a world of its own beside the others; the active world stays as it
			is.{data.running ? ' The server is running, so it arrives inactive: switch to it above once the server is stopped.' : ''}
		</p>
		<form onsubmit={uploadNewWorld}>
			<div class="field restore-scope">
				<label for="upload-world-name">Name</label>
				<input id="upload-world-name" name="name" maxlength="60" placeholder="The zip's name" />
			</div>
			<div class="field">
				<label for="upload-world-zip">World zip</label>
				<input id="upload-world-zip" name="world" type="file" accept=".zip,application/zip" />
			</div>
			<!-- Only a stopped server can switch worlds; while it runs the upload always arrives inactive. -->
			{#if !data.running}
				<div class="check">
					<input id="upload-activate" type="checkbox" name="activate" bind:checked={uploadActivate} />
					<label for="upload-activate">Make it the active world</label>
				</div>
				{#if uploadActivate && data.mapRendered}
					<div class="check">
						<input id="upload-keep-map" type="checkbox" name="keepMap" checked />
						<label for="upload-keep-map">Keep the map of {activeWorld?.name ?? data.levelName} for when it is active again</label>
					</div>
				{/if}
			{/if}
			<button class="button-primary" type="submit" disabled={newUploadPercent !== null}>
				{newUploadPercent !== null ? `Uploading ${newUploadPercent}%` : 'Upload as a new world'}
			</button>
			{#if newUploadMessage}<p class="hint">{newUploadMessage}</p>{/if}
			{#if newUploadError}<p class="hint warn-text">{newUploadError}</p>{/if}
		</form>
	</section>
{/if}
{:else if view === 'pregen'}
{#if data.chunky}
	<section class="view">
		<div class="section-head">
			<div>
				<h2>Pre-generate chunks</h2>
				<p>
					Chunky generates the world ahead of time, so exploring new land does not lag the server. The chunks it makes
					are the same ones players would.
				</p>
			</div>
		</div>

		{#if data.chunky.status?.running.length}
			<ul class="pregen">
				{#each data.chunky.status.running as task (task.world)}
					<li>
						<div class="spread">
							<strong class="mono">{task.world}</strong>
							<span class="mono">{task.percent.toFixed(2)}%</span>
						</div>
						<div class="meter" role="progressbar" aria-valuenow={task.percent} aria-valuemin={0} aria-valuemax={100} aria-label="{task.world} generated">
							<span style:width="{Math.min(100, task.percent)}%"></span>
						</div>
						<div class="spread small">
							<span class="muted">
								{task.chunks.toLocaleString()} chunks, {task.rate} per second, about {clock(task.etaSeconds)} left
							</span>
							<span class="row">
								<form method="POST" action="?/chunkyPause" use:enhance>
									<input type="hidden" name="world" value={task.world} />
									<button class="button-quiet">Pause</button>
								</form>
								<form method="POST" action="?/chunkyCancel" use:enhance={confirmCancel(task.world)}>
									<input type="hidden" name="world" value={task.world} />
									<button class="button-quiet button-danger">Cancel</button>
								</form>
							</span>
						</div>
					</li>
				{/each}
			</ul>
		{:else if data.chunky.status && !data.chunky.english && data.chunky.status.text}
			<pre class="chunky-says">{data.chunky.status.text}</pre>
		{/if}

		{#if data.chunky.unfinished.length}
			<h3>Paused or unfinished</h3>
			<ul class="pregen">
				{#each data.chunky.unfinished as task (task.world)}
					<li class="spread">
						<span>
							<strong class="mono">{task.world}</strong>
							<span class="muted small">
								{task.chunks.toLocaleString()} chunks done, {task.shape} of radius {task.radius.toLocaleString()}{task.radiusZ !== null &&
								(task.shape === 'rectangle' || task.shape === 'ellipse')
									? ` by ${task.radiusZ.toLocaleString()}`
									: ''} around
								{task.centerX}, {task.centerZ}{data.chunky.pausedForPlayers.includes(task.world) ? ', paused while players are online' : ''}
							</span>
						</span>
						{#if data.running}
							<span class="row">
								<form method="POST" action="?/chunkyContinue" use:enhance>
									<input type="hidden" name="world" value={task.world} />
									<button>Continue</button>
								</form>
								<form method="POST" action="?/chunkyCancel" use:enhance={confirmCancel(task.world)}>
									<input type="hidden" name="world" value={task.world} />
									<button class="button-quiet button-danger">Cancel</button>
								</form>
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if form && 'chunkyConfirm' in form && form.chunkyConfirm}
			<div class="notice warning">
				<p>{form.chunkyConfirm} has an unfinished task. Continue it, or start over with the new selection?</p>
				<div class="button-row">
					<form method="POST" action="?/chunkyContinue" use:enhance>
						<input type="hidden" name="world" value={form.chunkyConfirm} />
						<button>Continue it</button>
					</form>
					<form method="POST" action="?/chunkyConfirm" use:enhance>
						<button class="button-danger">Start over</button>
					</form>
				</div>
			</div>
		{/if}

		<PregenPlanner
			instanceId={data.instance.id}
			dimensions={data.chunky.dimensions}
			running={data.running}
			generating={data.chunky.status?.running.map((t) => t.world) ?? []}
		/>

		<form method="POST" action="?/chunkyAuto" use:enhance class="auto">
			<input type="hidden" name="enabled" value={String(!data.chunky.pauseForPlayers)} />
			<span class="small">
				{#if data.chunky.english}
					{data.chunky.pauseForPlayers
						? 'Pre-generation pauses while anyone is online and continues when the server is empty.'
						: 'Pre-generation runs whether or not anyone is online.'}
				{:else}
					Pausing while players are online needs Chunky set to English ("language" in config/chunky/config.json, or
					config/chunky.json before Minecraft 1.19.3):
					MineShell reads which tasks run from its messages.
				{/if}
			</span>
			<button class="button-quiet" disabled={!data.chunky.english && !data.chunky.pauseForPlayers}>
				{data.chunky.pauseForPlayers ? 'Run it regardless' : 'Pause while players are online'}
			</button>
		</form>
		<form method="POST" action="?/chunkyRestart" use:enhance class="auto">
			<input type="hidden" name="enabled" value={String(!data.chunky.continueOnRestart)} />
			<span class="small">
				{data.chunky.continueOnRestart
					? 'Unfinished pre-generation continues by itself when the server starts again, after a scheduled restart too.'
					: 'After a restart, unfinished pre-generation waits until you press Continue.'}
			</span>
			<button class="button-quiet">{data.chunky.continueOnRestart ? 'Wait for Continue' : 'Continue after a restart'}</button>
		</form>
		<p class="faint small">
			To run it only at certain hours, add scheduled commands <code>chunky continue</code> and <code>chunky pause</code>
			in <a href="/instances/{encodeURIComponent(data.instance.id)}/settings?tab=automation">Settings → Automation</a>.
		</p>
	</section>
{:else}
	<div class="empty">
		<p>
			Pre-generating uses the Chunky mod, which this server does not have. Add it from Mods → Add mods and restart;
			this tab then offers a dimension, shape and radius to generate.
		</p>
	</div>
{/if}
{:else if view === 'prune'}
{#if data.dimensions.length}
	<section class="view">
		<div class="section-head">
			<div>
				<h2>Prune chunks</h2>
				<p>
					Deletes chunks that were generated but hardly visited, so they generate again when someone goes there. That is
					what flying through and pre-generation leave behind, and usually most of a world's size. Minecraft counts how
					long players spent near each chunk; builds are in chunks people spent time in. Terrain that generates again
					uses the current seed, mods and data packs, so it can differ from what was there.
				</p>
			</div>
		</div>
		<PruneMap
			instanceId={data.instance.id}
			dimensions={data.dimensions}
			analysis={data.pruneAnalysis}
			analysing={data.pruneAnalysing}
			mayCancel={mayCancelTask(data.access, { instanceId: data.instance.id })}
			running={data.running}
			{busy}
			snapshotPrompt={data.snapshotPrompt}
		/>
	</section>
{:else}
	<div class="empty"><p>No world yet, so nothing to prune.</p></div>
{/if}
{:else}
<div class="cards">
<section class="panel" use:dropzone={{ disabled: data.running || busy || uploadPercent !== null, label: 'Drop the world zip here' }}>
	<h2>Replace the world</h2>
	<p class="muted">
		Upload a zipped world, e.g. a singleplayer save. The folder holding <code>level.dat</code> becomes
		<code>{data.levelName}</code>; whether it was zipped by itself or inside another folder does not matter.
	</p>
	<form onsubmit={uploadWorld}>
		<div class="field">
			<label for="world-zip">World zip</label>
			<input id="world-zip" name="world" type="file" accept=".zip,application/zip" />
		</div>
		<SnapshotChoice moves prompt={data.snapshotPrompt} idPrefix="replace" />
		{#if data.running}<p class="hint">Stop the server to replace its world.</p>{/if}
		<button class="button-primary" type="submit" disabled={data.running || busy || uploadPercent !== null}>
			{uploadPercent !== null ? `Uploading ${uploadPercent}%` : 'Upload and replace'}
		</button>
		{#if uploadMessage}<p class="hint">{uploadMessage}</p>{/if}
		{#if uploadError}<p class="hint warn-text">{uploadError}</p>{/if}
	</form>
</section>

<section class="panel danger">
	<h2>Reset the world</h2>
	<p class="muted">
		Removes the world, so the next start generates a new one. Player data stored in the world goes with it.
	</p>
	<form
		method="POST"
		action="?/reset"
		use:enhance={({ cancel }) => {
			if (!confirm(`Reset the world of ${data.instance.name}?`)) cancel();
		}}
	>
		<div class="field">
			<span class="label" id="reset-seed-label">Seed</span>
			<div class="seed-row">
				<SegmentedChoice
					options={[
						{ value: 'keep', label: 'Keep it' },
						{ value: 'random', label: 'New random' },
						{ value: 'set', label: 'This seed' }
					]}
					bind:value={seedMode}
					name="seedMode"
					labelledby="reset-seed-label"
				/>
				{#if seedMode === 'set'}<input name="seed" aria-label="Seed" placeholder="Seed" class="mono" />{/if}
			</div>
			{#if seedMode === 'keep'}
				<p class="hint">{data.worldSeed || data.seed ? `The current seed: ${data.worldSeed ?? data.seed}.` : 'The current one is random: the new world gets another.'}</p>
			{/if}
		</div>
		<SnapshotChoice moves prompt={data.snapshotPrompt} idPrefix="reset" />
		{#if data.running}<p class="hint">Stop the server to reset its world.</p>{/if}
		<button class="button-danger" type="submit" disabled={data.running || busy || !data.worlds.length}>Reset the world</button>
	</form>

	{#if data.dimensions.length}
		<h3 class="dimension-heading">Reset one dimension</h3>
		<p class="muted small">
			Removes one dimension so it generates again, with the world's seed, the next time it is loaded; the rest of the
			world stays. Resetting the overworld removes its terrain only: player data, level.dat and the world's data stay.
			Players inside it come back at the same spot in the new terrain.
		</p>
		<form
			method="POST"
			action="?/resetDimension"
			use:enhance={({ formData, cancel }) => {
				const key = String(formData.get('dimension'));
				const label = data.dimensions.find((d) => d.key === key)?.label ?? key;
				if (!confirm(`Reset ${label} of ${data.instance.name}?`)) cancel();
			}}
		>
			<div class="field restore-scope">
				<label for="reset-dimension">Dimension</label>
				<select id="reset-dimension" name="dimension">
					{#each data.dimensions as d (d.key)}
						<option value={d.key}>{d.label}</option>
					{/each}
				</select>
			</div>
			<SnapshotChoice moves prompt={data.snapshotPrompt} idPrefix="reset-dimension" />
			<button class="button-danger" type="submit" disabled={data.running || busy}>Reset this dimension</button>
		</form>
	{/if}
</section>
</div>
{/if}

<style>
	.new-world {
		margin-top: var(--space-4);
	}

	.after {
		margin: var(--space-3) 0 0;
	}

	.cards {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.cards > .panel {
		margin: 0;
	}

	.restore-scope {
		max-width: 28rem;
	}

	.dimension-heading {
		margin-top: var(--space-5);
		padding-top: var(--space-4);
		border-top: 1px solid var(--line);
	}

	.pregen {
		list-style: none;
		margin: 0 0 var(--space-4);
		padding: 0;
		display: grid;
		gap: var(--space-3);
	}

	.pregen li {
		display: grid;
		gap: var(--space-1);
	}

	.pregen li.spread {
		display: flex;
	}

	/* One task, one value: how much of the selection is generated. */
	.meter {
		height: 8px;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		overflow: hidden;
	}

	.meter span {
		display: block;
		height: 100%;
		background: var(--accent);
	}

	.chunky-says {
		white-space: pre-wrap;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-3);
		font-size: 0.8rem;
	}

	.auto {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--space-3);
		margin-top: var(--space-4);
		padding-top: var(--space-3);
		border-top: 1px solid var(--line);
	}

	.auto + .auto {
		margin-top: 0;
		border-top: 0;
	}

	.danger {
		border-color: color-mix(in srgb, var(--error) 30%, var(--line));
	}

	.warn-text {
		color: var(--warning);
	}

	.row-actions {
		display: flex;
		gap: var(--space-2);
		justify-content: flex-end;
		align-items: center;
	}

	/* A snapshot row: its summary takes the width, the actions keep theirs. */
	.snapshot-table td {
		vertical-align: middle;
	}
	.snapshot-table .actions-cell {
		width: 1%;
		white-space: nowrap;
	}
	.snap-name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-2);
	}
	.snap-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0 var(--space-3);
		margin-top: 0.15rem;
		color: var(--text-muted);
	}
	/* Edit and Delete: in the row on wide windows, in its ⋯ menu on narrow ones. */
	.snapshot-table .narrow-only {
		display: none;
	}
	/* With a mouse the buttons need less room around them, which leaves more for the summary. */
	@media (pointer: fine) {
		.snapshot-table .row-actions .button-quiet {
			padding-inline: 0.45rem;
		}
	}
	/* Narrow windows: the actions go under the summary instead of off the side. */
	@media (max-width: 60rem) {
		.snapshot-table tr:not(.confirm-row) td {
			display: block;
		}
		.snapshot-table tr:not(.confirm-row) td:first-child {
			border-bottom: none;
			padding-bottom: var(--space-1);
		}
		.snapshot-table .wide-only {
			display: none;
		}
		.snapshot-table .narrow-only {
			display: flex;
		}
		.snapshot-table .actions-cell {
			width: auto;
			padding-top: 0;
			white-space: normal;
		}
		.snapshot-table .row-actions {
			justify-content: flex-start;
			flex-wrap: wrap;
		}
		.snapshot-table .row-actions form {
			min-width: 0;
			text-align: left;
		}
	}

	.row-actions form {
		/* Pin and Unpin differ in width; a fixed slot keeps every row's buttons in line. */
		min-width: 4.5rem;
		text-align: right;
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

	.tag-filter {
		margin-bottom: var(--space-3);
	}

	.backup-copies {
		margin-top: var(--space-5);
	}
	.backup-copies h3 {
		margin-bottom: var(--space-1);
	}
	.bad-text {
		color: var(--error);
	}
	.inline-form {
		display: flex;
		gap: var(--space-3);
		align-items: flex-end;
		margin-bottom: var(--space-3);
	}
	.inline-form .field {
		margin-bottom: 0;
	}

	.snapshot-edit {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: var(--space-3);
		align-items: start;
	}

	.snapshot-edit .button-row {
		grid-column: 1 / -1;
	}

	@media (max-width: 60rem) {
		.snapshot-edit {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.confirm-row td {
		background: var(--bg-sunken);
	}

	/* Under the Delete button that opened it, at the row's end: no trip across the table. */
	.confirm-row .at-end {
		justify-content: flex-end;
		align-items: center;
	}

	.seed-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.seed-row > input {
		flex: 0 1 16rem;
	}
</style>
