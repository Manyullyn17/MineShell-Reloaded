<script lang="ts">
	import { enhance } from '$app/forms';
	import Flash from '$lib/components/Flash.svelte';
	import { formatBytes, formatRelative } from '$lib/shared/format';

	let { data, form } = $props();

	let renaming = $state<string | null>(null);
	let renameValue = $state('');
	let newFolder = $state('');
	let showNewFolder = $state(false);

	const base = $derived(`/instances/${data.instance.id}/files`);

	function href(dir: string) {
		return dir ? `${base}?path=${encodeURIComponent(dir)}` : base;
	}

	function startRename(relPath: string, name: string) {
		renaming = relPath;
		renameValue = name;
	}
</script>

<Flash {form} />

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
	<section class="panel">
		<nav class="crumbs" aria-label="Folder path">
			<a href={href('')}>{data.instance.id}</a>
			{#each data.crumbs as crumb (crumb.path)}
				<span class="sep" aria-hidden="true">/</span>
				<a href={href(crumb.path)}>{crumb.label}</a>
			{/each}
		</nav>

		<div class="toolbar">
			{#if data.parentDir !== null}
				<a class="button button-quiet" href={href(data.parentDir)}>Up one level</a>
			{/if}
			<button class="button-quiet" onclick={() => (showNewFolder = !showNewFolder)}>
				New folder
			</button>
			<a class="button button-quiet" href="/instances/{encodeURIComponent(data.instance.id)}/files/usage">Disk usage</a>
			<form method="POST" action="?/upload" enctype="multipart/form-data" use:enhance class="upload">
				<input type="hidden" name="dir" value={data.dir} />
				<input type="file" name="files" multiple aria-label="Files to upload" />
				<button type="submit">Upload here</button>
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
					{#each data.entries as entry (entry.relPath)}
						<tr>
							<td>
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
									<a href={href(entry.relPath)} class="entry">
										<span class="glyph" aria-hidden="true">▸</span>{entry.name}
									</a>
								{:else if entry.editable}
									<a href="{base}?path={encodeURIComponent(data.dir)}&edit={encodeURIComponent(entry.relPath)}" class="entry">
										{entry.name}
									</a>
								{:else}
									<span class="entry mono">{entry.name}</span>
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
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
{/if}

<style>
	.crumbs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem;
		font-family: var(--font-mono);
		font-size: 0.85rem;
		margin-bottom: var(--space-4);
		padding-bottom: var(--space-3);
		border-bottom: 1px solid var(--line);
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

	.upload {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		margin-left: auto;
		flex-wrap: wrap;
	}

	.upload input[type='file'] {
		width: auto;
		font-size: 0.8rem;
		padding: 0.25rem;
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

	.glyph {
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
</style>
