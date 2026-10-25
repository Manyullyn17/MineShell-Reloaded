<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import Flash from '#lib/components/Flash.svelte';
	import { formatBytes } from '#lib/shared/format.js';
	import { streamed } from '#lib/shared/streamed.svelte.js';

	let { data, form } = $props();

	const sizeInfo = streamed(() => data.sizes, () => data.instance.id);
	const sizes = $derived(sizeInfo.ready ? sizeInfo.value : null);
	const size = (bytes: number | undefined) => (sizes ? formatBytes(bytes ?? 0) : '…');

	let submitting = $state(false);
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

	const download = $derived(task?.state === 'done' && taskId ? `/api/instances/${encodeURIComponent(data.instance.id)}/export/server?task=${taskId}` : null);
	// Saved as soon as it is built (an attachment, so the page stays); the button is for another copy.
	let fetched: string | null = null;
	$effect(() => {
		if (!download || fetched === taskId) return;
		fetched = taskId;
		location.assign(download);
	});
</script>

<svelte:head><title>Export - {data.instance.name} - MineShell</title></svelte:head>

<div class="subhead">
	<nav class="subtabs" aria-label="Export">
		<a href="/instances/{encodeURIComponent(data.instance.id)}/export">Client pack</a>
		<a href="/instances/{encodeURIComponent(data.instance.id)}/export/mods">Mod list</a>
		<a href="/instances/{encodeURIComponent(data.instance.id)}/export/server" aria-current="page">Move to another MineShell</a>
	</nav>
</div>

<header class="section-head">
	<div>
		<h2>Export the server</h2>
		<p>
			One file another MineShell imports (Add a server, Import from another MineShell): the server's files, settings and
			mod records. Mods on Modrinth and CurseForge are downloaded again there instead of going in the file; the loader is
			installed again too.
		</p>
	</div>
</header>

<Flash form={form && 'message' in form ? form : null} />

<form
	method="POST"
	action="?/export"
	use:enhance={() => {
		task = null;
		submitting = true;
		return async ({ update }) => {
			await update({ reset: false });
			submitting = false;
		};
	}}
>
	<section class="panel block">
		<h3>What goes in</h3>
		<p class="small muted">
			Always: configs, scripts, mods that cannot be downloaded again, player lists and the server's settings in MineShell.
			Never: the loader's own files, the trash, and what belongs to this machine (ports, RCON password, Java, accounts,
			playit tunnels, notification destinations).
		</p>
		<div class="choices">
			<label class="check"><input type="checkbox" name="worlds" checked /> Worlds <span class="faint mono small">{size(sizes?.worlds)}</span></label>
			<label class="check"><input type="checkbox" name="snapshots" /> Snapshots <span class="faint mono small">{size(sizes?.snapshots)}</span></label>
			<label class="check"><input type="checkbox" name="logs" /> Logs and crash reports <span class="faint mono small">{size(sizes?.logs)}</span></label>
			{#if !sizes || sizes.mapTiles > 0}
				<label class="check"><input type="checkbox" name="mapTiles" /> A map mod's tiles <span class="faint mono small">{size(sizes?.mapTiles)}</span></label>
			{/if}
		</div>
		{#if data.running}
			<p class="small muted">The server is running: saving is paused while the world is copied, as for a world download.</p>
		{/if}
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
					<a class="button" href={download} download>Download the export</a>
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

<style>
	.block {
		padding: var(--space-4);
		margin-bottom: var(--space-4);
	}

	h3 {
		font-size: 1rem;
		margin: 0 0 var(--space-2);
	}

	.choices {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}

	.check {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
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
