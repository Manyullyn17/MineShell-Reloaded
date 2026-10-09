<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import Flash from '#lib/components/Flash.svelte';
	import { formatBytes } from '#lib/shared/format.js';

	let { data, form } = $props();

	type Plan = Awaited<typeof data.plan>;
	type Format = (typeof data.formats)[number]['id'];

	let format = $state<Format>('mrpack');
	let name = $state('');
	let version = $state('');
	let modFilter = $state('');
	/** Mod files and folders left out; everything else is in. Kept as exclusions so defaults fill in once the plan loads. */
	let excludedMods = $state<Set<string> | null>(null);
	let excludedFolders = $state<Set<string> | null>(null);
	let submitting = $state(false);

	function prime(plan: Plan) {
		if (excludedMods) return;
		name = plan.defaultName;
		version = plan.defaultVersion;
		// Only a Prism instance keeps Cleanroom.
		if (plan.loaderNotes.mrpack) format = 'prism';
		excludedMods = new Set();
		excludedFolders = new Set(plan.folders.filter((f) => !f.include).map((f) => f.name));
	}

	$effect(() => {
		void data.plan.then(prime, () => undefined);
	});

	function toggle(set: Set<string> | null, key: string, on: boolean): Set<string> {
		const next = new Set(set);
		if (on) next.delete(key);
		else next.add(key);
		return next;
	}

	type Task = { id: string; state: string; progress: number | null; step: string; error: string | null };
	let task = $state<Task | null>(null);
	const taskId = $derived((form as { taskId?: string } | null)?.taskId ?? null);

	// Follows the export's task on the same stream as the notification center.
	$effect(() => {
		const id = taskId;
		if (!id) return;
		task = null;
		const source = new EventSource('/api/tasks?stream=1&brief=1');
		source.addEventListener('tasks', (event) => {
			const found = (JSON.parse((event as MessageEvent).data) as Task[]).find((t) => t.id === id);
			if (found) task = found;
			if (found && found.state !== 'running') source.close();
		});
		return () => source.close();
	});

	const download = $derived(task?.state === 'done' && taskId ? `/api/instances/${encodeURIComponent(data.instance.id)}/export?task=${taskId}` : null);

	// The browser saves it as soon as it is built (the response is an attachment, so the page stays); the button is for another copy.
	let fetched: string | null = null;
	$effect(() => {
		if (!download || fetched === taskId) return;
		fetched = taskId;
		location.assign(download);
	});
</script>

<svelte:head><title>Export - {data.instance.name} - MineShell</title></svelte:head>

<header class="section-head">
	<div>
		<h2>Export a client pack</h2>
		<p>A pack your players import into their launcher, with this server's mods and configs.</p>
	</div>
</header>

<Flash form={form && 'message' in form ? form : null} />

{#await data.plan}
	<p class="muted">Looking through the mods.</p>
{:then plan}
	{@const shownMods = plan.mods.filter((m) => !modFilter || m.name.toLowerCase().includes(modFilter.toLowerCase()) || m.file.toLowerCase().includes(modFilter.toLowerCase()))}
	{@const includedCount = plan.mods.filter((m) => !excludedMods?.has(m.file)).length}
	<form
		method="POST"
		action="?/export"
		use:enhance={() => {
			// The last export's download link goes until this one is under way.
			task = null;
			submitting = true;
			return async ({ update }) => {
				await update({ reset: false });
				submitting = false;
			};
		}}
	>
		<section class="panel block">
			<h3>Format</h3>
			<div class="formats" role="radiogroup" aria-label="Format">
				{#each data.formats as f (f.id)}
					<label class="format" class:picked={format === f.id}>
						<input type="radio" name="format" value={f.id} bind:group={format} />
						<span>{f.label}</span>
					</label>
				{/each}
			</div>
			<p class="small muted">
				{#if format === 'mrpack'}
					Mods on Modrinth are linked and downloaded by the launcher; the rest are bundled inside the pack.
				{:else if format === 'curseforge'}
					Mods from CurseForge are linked by project and file; the rest, and disabled mods, are bundled inside the pack.
				{:else}
					Every file is bundled, so the instance works offline; import it in Prism with Add Instance, Import.
				{/if}
			</p>
			{#if plan.loaderNotes[format]}<p class="notice warning">{plan.loaderNotes[format]}</p>{/if}

			<div class="grid-2">
				<div class="field">
					<label for="export-name">Pack name</label>
					<input id="export-name" name="name" bind:value={name} />
				</div>
				<div class="field">
					<label for="export-version">Version</label>
					<input id="export-version" name="version" bind:value={version} />
				</div>
			</div>
			{#if plan.pack}
				<p class="small muted">
					Installed from <strong>{plan.pack.name}</strong>{plan.pack.version ? ` ${plan.pack.version}` : ''}: its
					client-side files that are not on the server (client-only mods, shaders, client options) are added from the
					pack.
				</p>
			{/if}
		</section>

		<section class="panel block">
			<h3>Folders and files</h3>
			<p class="small muted">The world, logs and the server's own files are never included.</p>
			{#if plan.folders.length === 0}
				<p class="small faint">Nothing besides the mods.</p>
			{:else}
				<div class="folders">
					{#each plan.folders as f (f.name)}
						<label class="check">
							<input
								type="checkbox"
								name="folder"
								value={f.name}
								checked={!excludedFolders?.has(f.name)}
								onchange={(e) => (excludedFolders = toggle(excludedFolders, f.name, e.currentTarget.checked))}
							/>
							<span class="mono">{f.name}{f.dir ? '/' : ''}</span>
						</label>
					{/each}
				</div>
			{/if}
		</section>

		<section class="panel block">
			<div class="mods-head">
				<div>
					<h3>Mods <span class="count">{includedCount} of {plan.mods.length}</span></h3>
					<p class="small muted">
						All of them by default: server-only mods do nothing on a client, but a singleplayer world then plays
						like the server. Client-only mods the server has disabled are exported enabled; other disabled mods stay
						disabled.
					</p>
				</div>
				<div class="row">
					<input type="search" placeholder="Filter" aria-label="Filter mods" bind:value={modFilter} />
					<button type="button" class="button-quiet" onclick={() => (excludedMods = new Set())}>All</button>
					<button type="button" class="button-quiet" onclick={() => (excludedMods = new Set(plan.mods.map((m) => m.file)))}>None</button>
				</div>
			</div>
			<!-- Every mod is posted, filtered or not. -->
			{#each plan.mods as m (m.file)}
				{#if !excludedMods?.has(m.file)}<input type="hidden" name="mod" value={m.file} />{/if}
			{/each}
			<div class="table-box">
				<table>
					<tbody>
						{#each shownMods as m (m.file)}
							<tr class:out={excludedMods?.has(m.file)}>
								<td class="tick">
									<input
										type="checkbox"
										aria-label="Include {m.name}"
										checked={!excludedMods?.has(m.file)}
										onchange={(e) => (excludedMods = toggle(excludedMods, m.file, e.currentTarget.checked))}
									/>
								</td>
								<td>
									<div>{m.name}</div>
									<div class="faint small mono">{m.file}</div>
								</td>
								<td class="tags">
									{#if m.clientOnly}<span class="tag accent">client-only, exported enabled</span>{/if}
									{#if !m.enabled}<span class="tag">disabled</span>{/if}
								</td>
								<td class="size faint small">{formatBytes(m.sizeBytes)}</td>
							</tr>
						{:else}
							<tr><td class="faint small" colspan="4">{plan.mods.length ? 'No mod matches the filter.' : 'This server has no mods.'}</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<div class="actions">
			<button class="button-primary" type="submit" disabled={submitting || task?.state === 'running'}>
				{submitting ? 'Starting' : 'Export'}
			</button>
			{#if task}
				<div class="progress-box">
					{#if task.state === 'running'}
						<div class="small muted">{task.step}{task.progress !== null ? ` · ${task.progress}%` : ''}</div>
						<div class="progress" role="progressbar" aria-valuenow={task.progress ?? undefined}>
							<span class:indeterminate={task.progress === null} style="width: {task.progress ?? 100}%"></span>
						</div>
					{:else if download}
						<a class="button" href={download} download>Download the pack</a>
						<span class="small faint">Downloading; kept here for an hour.</span>
					{:else if task.state === 'failed'}
						<p class="notice error">{task.error ?? 'The export failed.'}</p>
					{:else}
						<span class="small muted">Cancelled.</span>
					{/if}
				</div>
			{/if}
		</div>
	</form>
{:catch err}
	<p class="notice error">Could not read the server's mods: {err instanceof Error ? err.message : String(err)}</p>
{/await}

<style>
	.block {
		padding: var(--space-4);
		margin-bottom: var(--space-4);
	}

	h3 {
		font-size: 1rem;
		margin: 0 0 var(--space-2);
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.formats {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
		margin-bottom: var(--space-2);
	}

	.format {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		padding: 0.5rem 0.8rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		cursor: pointer;
	}

	.format.picked {
		border-color: var(--accent);
	}

	.folders {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
	}

	.check {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
	}

	.mods-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}

	.mods-head p {
		margin: 0;
	}

	.mods-head input[type='search'] {
		width: 12rem;
	}

	table {
		width: 100%;
	}

	.tick {
		width: 2rem;
	}

	tr.out td {
		opacity: 0.55;
	}

	.tags {
		text-align: right;
		white-space: nowrap;
	}

	.size {
		width: 5rem;
		text-align: right;
		white-space: nowrap;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		flex-wrap: wrap;
	}

	.progress-box {
		flex: 1 1 18rem;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.progress-box:has(a) {
		flex-direction: row;
		align-items: center;
		gap: var(--space-3);
	}

	.progress-box .notice {
		margin: 0;
	}
</style>
