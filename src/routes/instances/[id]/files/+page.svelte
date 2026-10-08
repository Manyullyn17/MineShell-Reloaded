<script lang="ts">
	import { applyAction, deserialize } from '$app/forms';
	import { refreshAll } from '$app/navigation';
	import { enhance } from '#lib/shared/forms.js';
	import { untrack } from 'svelte';
	import Flash from '#lib/components/Flash.svelte';
	import { formatBytes, formatRelative } from '#lib/shared/format.js';

	let { data, form } = $props();

	let renaming = $state<string | null>(null);
	let renameValue = $state('');
	let newFolder = $state('');
	let showNewFolder = $state(false);
	let uploadForm = $state<HTMLFormElement | null>(null);
	/** Short names for the usage bar; the usage page has the long ones. */
	const SHORT: Record<string, string> = {
		world: 'World',
		mods: 'Mods',
		logs: 'Logs',
		mineshell: 'Snapshots',
		'old-configs': 'Old configs',
		loader: 'Loader',
		other: 'Other'
	};

	const base = $derived(`/instances/${data.instance.id}/files`);

	function href(dir: string) {
		return dir ? `${base}?path=${encodeURIComponent(dir)}` : base;
	}

	/** Folders opened in place, by path, with their entries once listed. */
	let expanded = $state<Record<string, typeof data.entries | 'loading'>>({});

	async function list(relPath: string) {
		const res = await fetch(`/api/instances/${encodeURIComponent(data.instance.id)}/files?list&path=${encodeURIComponent(relPath)}`);
		return res.ok ? ((await res.json()).entries as typeof data.entries) : [];
	}

	async function toggle(relPath: string) {
		if (expanded[relPath]) {
			// Closing a folder closes what was open inside it.
			for (const key of Object.keys(expanded)) if (key === relPath || key.startsWith(`${relPath}/`)) delete expanded[key];
			return;
		}
		expanded[relPath] = 'loading';
		expanded[relPath] = await list(relPath);
	}

	// After an upload, rename or delete the open folders are listed again;
	// moving to another folder closes them.
	let listedDir = '';
	$effect(() => {
		const entries = data.entries;
		if (data.dir !== listedDir) {
			listedDir = data.dir;
			expanded = {};
			return;
		}
		void entries;
		// Keys read untracked: the refreshed listings written below must not rerun this.
		for (const key of untrack(() => Object.keys(expanded))) {
			list(key).then((found) => {
				if (expanded[key]) expanded[key] = found;
			});
		}
	});

	function startRename(relPath: string, name: string) {
		renaming = relPath;
		renameValue = name;
	}

	// ---- uploads: the button, or files and folders dropped anywhere on the page.
	let uploading = $state<number | null>(null);
	/** dragenter/dragleave fire for every element crossed: count them. */
	let dragDepth = $state(0);
	const dropping = $derived(dragDepth > 0 && !data.editing);

	const isFileDrag = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

	function onDragEnter(event: DragEvent) {
		if (!isFileDrag(event)) return;
		event.preventDefault();
		dragDepth++;
	}

	function onDragOver(event: DragEvent) {
		if (!isFileDrag(event)) return;
		// Without this the browser opens the file instead of dropping it here.
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = data.editing ? 'none' : 'copy';
	}

	function onDragLeave(event: DragEvent) {
		if (isFileDrag(event)) dragDepth = Math.max(0, dragDepth - 1);
	}

	function onDrop(event: DragEvent) {
		if (!isFileDrag(event)) return;
		event.preventDefault();
		dragDepth = 0;
		if (data.editing || !event.dataTransfer) return;
		// Entries must be taken now: the drop's items are gone after the first await.
		const entries = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter((e) => e != null);
		const plain = [...event.dataTransfer.files];
		void (async () => {
			const files = entries.length ? (await Promise.all(entries.map((e) => filesIn(e, '')))).flat() : plain.map((file) => ({ file, path: file.name }));
			await upload(files);
		})();
	}

	/** A dropped file, or every file inside a dropped folder with its path from there. */
	async function filesIn(entry: FileSystemEntry, prefix: string): Promise<{ file: File; path: string }[]> {
		const at = prefix + entry.name;
		if (entry.isFile) {
			const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
			return [{ file, path: at }];
		}
		const reader = (entry as FileSystemDirectoryEntry).createReader();
		const children: FileSystemEntry[] = [];
		// readEntries hands them over in batches (100 in Chrome) until an empty one.
		for (;;) {
			const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
			if (!batch.length) break;
			children.push(...batch);
		}
		return (await Promise.all(children.map((child) => filesIn(child, `${at}/`)))).flat();
	}

	/** Posts to the same action as the button, with each file named by its path. */
	async function upload(files: { file: File; path: string }[]) {
		if (!files.length || uploading !== null) return;
		const body = new FormData();
		body.set('dir', data.dir);
		body.set('withFolders', '1');
		for (const { file, path } of files) body.append('files', file, path);
		uploading = files.length;
		try {
			const res = await fetch(`${location.pathname}${location.search ? `${location.search}&` : '?'}/upload`, {
				method: 'POST',
				headers: { accept: 'application/json', 'x-sveltekit-action': 'true' },
				body
			});
			const result = deserialize(await res.text());
			if (result.type === 'success') await refreshAll();
			await applyAction(result);
		} catch {
			await applyAction({ type: 'failure', status: 500, location: location.href, data: { ok: false, message: 'The upload did not reach MineShell.' } });
		} finally {
			uploading = null;
		}
	}
</script>

<svelte:window ondragenter={onDragEnter} ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop} />

{#snippet entryRows(entries: typeof data.entries, depth: number)}
	{#each entries as entry (entry.relPath)}
						<tr>
			<td style:padding-left="{1 + depth * 1.4}rem">
				{#if renaming === entry.relPath}
					<form method="POST" action="?/rename" use:enhance class="inline-form">
						<input type="hidden" name="from" value={entry.relPath} />
						<input name="to" bind:value={renameValue} aria-label="New name" />
						<button class="button-primary" type="submit">Save</button>
						<button class="button-quiet" type="button" onclick={() => (renaming = null)}>
							Cancel
						</button>
					</form>
				{:else if entry.isDirectory}
					<span class="entry">
						<button
							type="button"
							class="toggle hit-area"
							aria-expanded={!!expanded[entry.relPath]}
							aria-label="{expanded[entry.relPath] ? 'Collapse' : 'Expand'} {entry.name}"
							onclick={() => toggle(entry.relPath)}>{expanded[entry.relPath] ? '▾' : '▸'}</button
						>
						<a href={href(entry.relPath)} title="Open {entry.name}">{entry.name}</a>
					</span>
				{:else if entry.editable}
					<a href="{base}?path={encodeURIComponent(data.dir)}&edit={encodeURIComponent(entry.relPath)}" class="entry">
						<span class="glyph" aria-hidden="true"></span>{entry.name}
					</a>
				{:else}
					<span class="entry"><span class="glyph" aria-hidden="true"></span>{entry.name}</span>
				{/if}
			</td>
			<td class="mono small nowrap">{entry.isDirectory ? '-' : formatBytes(entry.size)}</td>
			<td class="small nowrap faint">{formatRelative(entry.modified)}</td>
			<td>
				<div class="row-actions">
					{#if !entry.isDirectory}
						<a
							class="button button-quiet"
							href="/api/instances/{data.instance.id}/files?path={encodeURIComponent(entry.relPath)}"
						>
							Download
						</a>
					{/if}
					<button
						class="button-quiet"
						type="button"
						onclick={() => startRename(entry.relPath, entry.name)}
					>
						Rename
					</button>
					<form method="POST" action="?/delete" use:enhance>
						<input type="hidden" name="path" value={entry.relPath} />
						<button class="button-quiet button-danger" type="submit">Delete</button>
					</form>
				</div>
			</td>
		</tr>
		{#if entry.isDirectory && expanded[entry.relPath]}
			{@const children = expanded[entry.relPath]}
			{#if children === 'loading'}
				<tr><td colspan="4" class="faint small" style:padding-left="{2.4 + depth * 1.4}rem">Loading.</td></tr>
			{:else if children.length === 0}
				<tr><td colspan="4" class="faint small" style:padding-left="{2.4 + depth * 1.4}rem">Empty folder.</td></tr>
			{:else}
				{@render entryRows(children, depth + 1)}
			{/if}
		{/if}
	{/each}
{/snippet}

<Flash {form} />

{#if dropping}
	<div class="drop-overlay" aria-hidden="true">
		<p>Drop to upload into <span class="mono">{data.instance.id}/{data.dir}</span></p>
	</div>
{/if}

{#if data.listError}
	<div class="notice error"><p>{data.listError}</p></div>
{/if}

{#if data.editing}
	<section class="panel">
		<div class="panel-head">
			<div>
				<h2 class="mono file-title">{data.editing.path}</h2>
				<p>Saved straight to disk. Restart the server if the file is read at startup.</p>
			</div>
			<a class="button button-quiet" href={href(data.dir)}>Close</a>
		</div>
		<form method="POST" action="?/save" use:enhance>
			<input type="hidden" name="path" value={data.editing.path} />
			<textarea name="contents" rows="26" spellcheck="false" class="editor">{data.editing.contents}</textarea>
			<div class="button-row editor-actions">
				<button class="button-primary" type="submit">Save file</button>
				<a
					class="button button-quiet"
					href="/api/instances/{data.instance.id}/files?path={encodeURIComponent(data.editing.path)}"
				>
					Download
				</a>
			</div>
		</form>
	</section>
{:else}
	{#await data.usage then usage}
		{#if usage && usage.total > 0}
			<section class="usage">
				<div class="usage-head">
					<span class="muted small">{formatBytes(usage.total)} used by this server</span>
					<a class="small" href="{base}/usage">Where the space goes →</a>
				</div>
				<div class="bar" aria-hidden="true">
					{#each usage.groups as group (group.id)}
						<span data-group={group.id} style:flex-grow={group.bytes}></span>
					{/each}
				</div>
				<ul class="legend small">
					{#each usage.groups as group (group.id)}
						<li data-group={group.id} title={group.label}>
							<span class="swatch"></span>{SHORT[group.id] ?? group.label}
							<span class="mono faint">{formatBytes(group.bytes)}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/await}

	<section>
		<div class="toolbar">
			<nav class="crumbs" aria-label="Folder path">
				<a href={href('')}>{data.instance.id}</a>
				{#each data.crumbs as crumb (crumb.path)}
					<span class="sep" aria-hidden="true">/</span>
					<a href={href(crumb.path)}>{crumb.label}</a>
				{/each}
			</nav>
			{#if data.parentDir !== null}
				<a class="button button-quiet" href={href(data.parentDir)}>Up one level</a>
			{/if}
			<button class="button-quiet" onclick={() => (showNewFolder = !showNewFolder)}>New folder</button>
			<form
				method="POST"
				action="?/upload"
				enctype="multipart/form-data"
				use:enhance={({ formData }) => {
					uploading = formData.getAll('files').length;
					return async ({ update }) => {
						await update();
						uploading = null;
					};
				}}
				bind:this={uploadForm}
			>
				<input type="hidden" name="dir" value={data.dir} />
				<label class="button upload" title="Or drop files and folders anywhere on the page">
					{uploading === null ? 'Upload here' : `Uploading ${uploading} file${uploading === 1 ? '' : 's'}…`}
					<input
						type="file"
						name="files"
						multiple
						class="visually-hidden"
						onchange={() => uploadForm?.requestSubmit()}
					/>
				</label>
			</form>
		</div>

		{#if showNewFolder}
			<form method="POST" action="?/mkdir" use:enhance class="inline-form">
				<input type="hidden" name="dir" value={data.dir} />
				<input name="name" bind:value={newFolder} placeholder="Folder name" aria-label="Folder name" />
				<button class="button-primary" type="submit">Create</button>
			</form>
		{/if}

		{#if data.entries.length === 0}
			<div class="empty"><p>This folder is empty.</p></div>
		{:else}
			<div class="table-box">
			<table>
				<thead>
					<tr>
						<th>Name</th>
						<th class="nowrap">Size</th>
						<th class="nowrap">Modified</th>
						<th><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{@render entryRows(data.entries, 0)}
				</tbody>
			</table>
			</div>
		{/if}
	</section>
{/if}

<style>
	.usage {
		margin-bottom: 1.4rem;
	}

	.usage-head {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: 0.4rem;
	}

	.usage-head a {
		text-decoration: none;
	}

	.bar {
		display: flex;
		gap: 1px;
		height: 8px;
		border-radius: 2px;
		overflow: hidden;
		background: var(--bg-sunken);
	}

	.bar span {
		flex-basis: 0;
		min-width: 2px;
		background: var(--swatch);
	}

	[data-group] {
		--swatch: var(--text-faint);
	}
	[data-group='world'] {
		--swatch: var(--accent);
	}
	[data-group='mods'] {
		--swatch: var(--info);
	}
	[data-group='logs'] {
		--swatch: var(--warning);
	}
	[data-group='mineshell'] {
		--swatch: var(--text-muted);
	}
	[data-group='old-configs'] {
		--swatch: var(--error);
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 1rem;
		list-style: none;
		margin: 0.5rem 0 0;
		padding: 0;
		color: var(--text-muted);
	}

	.legend li {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.swatch {
		width: 8px;
		height: 8px;
		border-radius: 1px;
		background: var(--swatch);
	}

	.crumbs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem;
		font-family: var(--font-mono);
		font-size: 0.9rem;
		margin-right: auto;
	}

	.crumbs a {
		color: var(--text);
		text-decoration: none;
	}

	.crumbs a:hover {
		color: var(--accent-hover);
	}

	label.upload {
		margin: 0;
		color: var(--text);
		font-size: 0.9rem;
	}

	.sep {
		color: var(--text-faint);
	}

	.toolbar {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}

	.inline-form {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		margin-bottom: var(--space-3);
		flex-wrap: wrap;
	}

	.inline-form input {
		width: auto;
		flex: 1 1 12rem;
	}

	.entry {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		text-decoration: none;
		color: var(--text);
	}

	a.entry:hover {
		color: var(--accent-hover);
	}

	.toggle {
		width: 1.1rem;
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font-size: 0.75rem;
		font-weight: 400;
	}

	.entry a {
		color: inherit;
		text-decoration: none;
	}

	.entry a:hover {
		color: var(--accent-hover);
	}

	.glyph {
		display: inline-block;
		width: 1.1rem;
		color: var(--accent);
		font-size: 0.7rem;
	}

	.row-actions {
		display: flex;
		gap: var(--space-1);
		justify-content: flex-end;
		flex-wrap: wrap;
	}

	.row-actions button,
	.row-actions .button {
		font-size: 0.82rem;
		padding: 0.2rem 0.5rem;
	}

	.editor {
		font-family: var(--font-mono);
		font-size: 0.8rem;
		line-height: 1.5;
		white-space: pre;
		overflow-wrap: normal;
		overflow-x: auto;
	}

	.editor-actions {
		margin-top: var(--space-3);
	}

	.file-title {
		overflow-wrap: anywhere;
	}

	.drop-overlay {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: grid;
		place-items: center;
		padding: var(--space-4);
		background: color-mix(in srgb, var(--bg) 75%, transparent);
		border: 2px dashed var(--accent);
		pointer-events: none;
	}

	.drop-overlay p {
		margin: 0;
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-lg);
		background: var(--panel-raised);
		color: var(--text);
		font-size: 1.05rem;
		overflow-wrap: anywhere;
		text-align: center;
	}
</style>
