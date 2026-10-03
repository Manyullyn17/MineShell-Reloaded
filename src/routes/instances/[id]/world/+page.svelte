<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import Flash from '$lib/components/Flash.svelte';
	import SnapshotChoice from '$lib/components/SnapshotChoice.svelte';
	import { formatBytes, formatDateTime, formatRelative } from '$lib/shared/format';

	let { data, form } = $props();

	const base = $derived(`/api/instances/${encodeURIComponent(data.instance.id)}/world`);
	const busy = $derived(data.instance.status === 'provisioning');

	let pendingRestore = $state<string | null>(null);
	let pendingDelete = $state<string | null>(null);
	let seedMode = $state<'keep' | 'random' | 'set'>('keep');

	// Uploads go straight to the endpoint (not a form action), which takes the
	// raw file so a big world is never held in memory; XHR for the progress.
	let uploadPercent = $state<number | null>(null);
	let uploadMessage = $state('');
	let uploadError = $state('');

	function uploadWorld(event: SubmitEvent) {
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
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', `${base}?${params}`);
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable) uploadPercent = Math.round((e.loaded / e.total) * 100);
		};
		xhr.onload = () => {
			uploadPercent = null;
			const body = (() => {
				try {
					return JSON.parse(xhr.responseText);
				} catch {
					return {};
				}
			})();
			if (xhr.status >= 200 && xhr.status < 300) {
				uploadError = '';
				uploadMessage = 'Uploaded. Replacing the world; follow it in Tasks.';
				formEl.reset();
				void invalidateAll();
			} else {
				uploadMessage = '';
				uploadError =
					body.message ??
					(xhr.status === 413 ? 'The file is bigger than this MineShell accepts (BODY_SIZE_LIMIT).' : 'The upload failed.');
			}
		};
		xhr.onerror = () => {
			uploadPercent = null;
			uploadError = 'The upload failed.';
		};
		uploadError = '';
		uploadMessage = '';
		uploadPercent = 0;
		xhr.send(file);
	}

	function differs(s: (typeof data.snapshots)[number]) {
		return (
			s.minecraftVersion !== data.current.minecraftVersion ||
			s.modloader !== data.current.modloader ||
			s.modloaderVersion !== data.current.modloaderVersion
		);
	}
</script>

<Flash {form} />

<section class="panel">
	<div class="panel-head">
		<div>
			<h2>World</h2>
			{#if data.worlds.length}
				<p>
					<code>{data.worlds.join(', ')}</code>, {formatBytes(data.snapshotPrompt.worldBytes)}.
					{#if data.seed}Seed <code>{data.seed}</code>.{/if}
				</p>
			{:else}
				<p>
					No world yet; the server creates <code>{data.levelName}</code> on its first start.
				</p>
			{/if}
		</div>
		{#if data.worlds.length}
			<div class="button-row">
				<a class="button" href={base} download>Download as zip</a>
				<form method="POST" action="?/snapshot" use:enhance>
					<button type="submit" disabled={data.running || busy}>Snapshot now</button>
				</form>
			</div>
		{/if}
	</div>
	{#if data.running && data.worlds.length}
		<p class="hint">
			While the server runs, a download pauses saving (<code>save-off</code>) until the zip is done. Snapshots
			need it stopped.
		</p>
	{/if}
</section>

<section class="panel">
	<div class="panel-head">
		<div>
			<h2>Snapshots</h2>
			<p>
				Taken before risky operations and on request; the newest {data.snapshotPrompt.policy.keep} are kept
				(<a href="/settings">Settings</a>). Restoring keeps the current world as a snapshot first, unless you choose
				otherwise.
			</p>
		</div>
	</div>

	{#if data.snapshots.length === 0}
		<div class="empty"><p>No snapshots yet.</p></div>
	{:else}
		<table>
			<thead>
				<tr>
					<th>Taken</th>
					<th>Why</th>
					<th class="nowrap">Ran on</th>
					<th class="nowrap">Size</th>
					<th><span class="visually-hidden">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.snapshots as s (s.id)}
					<tr>
						<td class="nowrap">
							{formatDateTime(s.createdAt)}
							<div class="faint small">{formatRelative(s.createdAt)}</div>
						</td>
						<td>
							{s.label}
							<div class="faint small mono">{s.worlds.join(', ')}</div>
						</td>
						<td class="small nowrap" class:warn-text={differs(s)}>
							{s.minecraftVersion}, {s.modloader}{s.modloaderVersion ? ` ${s.modloaderVersion}` : ''}
							{#if s.packVersionName}<div class="faint">{s.packVersionName}</div>{/if}
						</td>
						<td class="mono small nowrap">{formatBytes(s.sizeBytes)}</td>
						<td>
							<div class="row-actions">
								<a class="button" href="{base}?snapshot={encodeURIComponent(s.id)}" download>Download</a>
								<button
									type="button"
									disabled={data.running || busy}
									onclick={() => {
										pendingRestore = pendingRestore === s.id ? null : s.id;
										pendingDelete = null;
									}}>Restore</button
								>
								<button
									type="button"
									class="button-danger"
									disabled={busy}
									onclick={() => {
										pendingDelete = pendingDelete === s.id ? null : s.id;
										pendingRestore = null;
									}}>Delete</button
								>
							</div>
						</td>
					</tr>
					{#if pendingRestore === s.id}
						<tr class="confirm-row">
							<td colspan="5">
								<form
									method="POST"
									action="?/restore"
									use:enhance={() => async ({ update }) => {
										pendingRestore = null;
										await update();
									}}
								>
									<input type="hidden" name="id" value={s.id} />
									<p>
										Replaces the current world with this snapshot from {formatDateTime(s.createdAt)}.
									</p>
									{#if differs(s)}
										<p class="warn-text small">
											This world last ran on Minecraft {s.minecraftVersion} with {s.modloader}
											{s.modloaderVersion ?? ''}; the server now runs {data.current.minecraftVersion} with
											{data.current.modloader} {data.current.modloaderVersion ?? ''}. If the mods or versions changed since,
											revert those too, or blocks and items from them may be lost.
										</p>
									{/if}
									<SnapshotChoice prompt={data.snapshotPrompt} idPrefix="restore-{s.id}" />
									<div class="button-row">
										<button class="button-primary" type="submit">Restore this snapshot</button>
										<button class="button-quiet" type="button" onclick={() => (pendingRestore = null)}>Cancel</button>
									</div>
								</form>
							</td>
						</tr>
					{:else if pendingDelete === s.id}
						<tr class="confirm-row">
							<td colspan="5">
								<form
									method="POST"
									action="?/deleteSnapshot"
									use:enhance={() => async ({ update }) => {
										pendingDelete = null;
										await update();
									}}
								>
									<input type="hidden" name="id" value={s.id} />
									<div class="button-row">
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
	{/if}
</section>

<section class="panel">
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
		<SnapshotChoice prompt={data.snapshotPrompt} idPrefix="replace" />
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
		<fieldset class="seed">
			<legend>Seed</legend>
			<div class="check">
				<input id="seed-keep" type="radio" name="seedMode" value="keep" bind:group={seedMode} />
				<label for="seed-keep">Keep the current one{data.seed ? ` (${data.seed})` : ' (random)'}</label>
			</div>
			<div class="check">
				<input id="seed-random" type="radio" name="seedMode" value="random" bind:group={seedMode} />
				<label for="seed-random">A new random seed</label>
			</div>
			<div class="check">
				<input id="seed-set" type="radio" name="seedMode" value="set" bind:group={seedMode} />
				<label for="seed-set">This seed:</label>
				<input name="seed" aria-label="Seed" disabled={seedMode !== 'set'} />
			</div>
		</fieldset>
		<SnapshotChoice prompt={data.snapshotPrompt} idPrefix="reset" />
		{#if data.running}<p class="hint">Stop the server to reset its world.</p>{/if}
		<button class="button-danger" type="submit" disabled={data.running || busy || !data.worlds.length}>Reset the world</button>
	</form>
</section>

<style>
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
		flex-wrap: wrap;
	}

	.confirm-row td {
		background: var(--bg-sunken);
	}

	.seed {
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
		margin: var(--space-3) 0;
	}

	.seed legend {
		font-size: 0.88rem;
		padding: 0 var(--space-1);
	}

	.seed input:not([type='radio']) {
		max-width: 16rem;
		margin-left: var(--space-2);
	}
</style>
