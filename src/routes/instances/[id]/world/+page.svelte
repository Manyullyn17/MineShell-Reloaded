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

	// ---- Chunky pre-generation
	let pregenWorld = $state('minecraft:overworld');
	let pregenShape = $state<'square' | 'circle'>('square');
	let pregenRadius = $state(2500);
	/** Chunks a selection covers, as Chunky counts them (16-block chunks). */
	const pregenChunks = $derived(
		pregenShape === 'circle'
			? Math.round((Math.PI * pregenRadius * pregenRadius) / 256)
			: Math.round(((2 * pregenRadius) / 16) ** 2)
	);
	const clock = (seconds: number) =>
		`${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
	// Progress moves on its own while a task runs; nothing else on this page does.
	$effect(() => {
		if (!data.chunky?.status?.running.length) return;
		const timer = setInterval(() => void invalidateAll(), 5000);
		return () => clearInterval(timer);
	});
	// ---- chunk pruning
	const PRUNE_TICKS = [
		{ ticks: 1, label: 'never (0 seconds)' },
		{ ticks: 100, label: '5 seconds' },
		{ ticks: 1200, label: '1 minute' },
		{ ticks: 6000, label: '5 minutes' },
		{ ticks: 36000, label: '30 minutes' }
	];
	let pruneDimension = $state('');
	let pruneTicks = $state(1200);
	let pruneKeep = $state(256);
	$effect(() => {
		if (!pruneDimension && data.dimensions.length) pruneDimension = data.dimensions[0].key;
	});
	const pruneIsOverworld = $derived(data.dimensions.find((d) => d.key === pruneDimension)?.overworld ?? false);
	const countMatches = $derived(
		data.pruneCount &&
			data.pruneCount.dimension === pruneDimension &&
			data.pruneCount.maxTicks === pruneTicks &&
			(!pruneIsOverworld || data.pruneCount.keepAroundSpawn === pruneKeep)
	);

	const confirmCancel = (world: string) => ({ cancel }: { cancel: () => void }) => {
		if (!confirm(`Cancel pre-generating ${world}? A cancelled task cannot be continued.`)) cancel();
	};

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
				Taken before risky operations and on request. At least the newest {data.snapshotPrompt.policy.keepMin} full
				and {data.snapshotPrompt.policy.partialMin} partial ones are kept, more while they fit in
				{formatBytes(data.snapshotPrompt.policy.budgetMb * 1024 * 1024)} (<a
					href="/instances/{encodeURIComponent(data.instance.id)}/settings">server settings</a>), plus any you pin. Restoring keeps the current world as a snapshot first,
				unless you choose otherwise.
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
							{#if s.pinned}<span class="tag accent">pinned</span>{/if}
							{#if s.partial}<span class="tag">part of the world</span>{/if}
							<div class="faint small mono">{s.worlds.join(', ')}</div>
						</td>
						<td class="small nowrap" class:warn-text={differs(s)}>
							{s.minecraftVersion}, {s.modloader}{s.modloaderVersion ? ` ${s.modloaderVersion}` : ''}
							{#if s.packVersionName}<div class="faint">{s.packVersionName}</div>{/if}
						</td>
						<td class="mono small nowrap">{formatBytes(s.sizeBytes)}</td>
						<td>
							<div class="row-actions">
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
									{#if s.partial}
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

{#if data.chunky}
	<section class="panel">
		<div class="panel-head">
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
								{task.chunks.toLocaleString()} chunks done, {task.shape} of radius {task.radius.toLocaleString()} around
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

		{#if data.running}
			<form method="POST" action="?/chunkyStart" use:enhance class="pregen-form">
				<div class="field">
					<label for="pregen-world">Dimension</label>
					<select id="pregen-world" name="world" bind:value={pregenWorld}>
						<option value="minecraft:overworld">Overworld</option>
						<option value="minecraft:the_nether">The Nether</option>
						<option value="minecraft:the_end">The End</option>
						<option value="other">Another dimension</option>
					</select>
				</div>
				{#if pregenWorld === 'other'}
					<div class="field">
						<label for="pregen-custom">Dimension id</label>
						<input id="pregen-custom" name="customWorld" class="mono" placeholder="twilightforest:twilight_forest" />
					</div>
				{/if}
				<div class="field">
					<label for="pregen-shape">Shape</label>
					<select id="pregen-shape" name="shape" bind:value={pregenShape}>
						<option value="square">Square</option>
						<option value="circle">Circle</option>
					</select>
				</div>
				<div class="field">
					<label for="pregen-x">Center X</label>
					<input id="pregen-x" name="centerX" type="number" value="0" step="1" />
				</div>
				<div class="field">
					<label for="pregen-z">Center Z</label>
					<input id="pregen-z" name="centerZ" type="number" value="0" step="1" />
				</div>
				<div class="field">
					<label for="pregen-radius">Radius in blocks</label>
					<input id="pregen-radius" name="radius" type="number" min="16" step="1" bind:value={pregenRadius} />
				</div>
				<button class="button-primary" type="submit">Start</button>
			</form>
			<p class="muted small pregen-note">
				About {pregenChunks.toLocaleString()} chunks. Generation is heavy work for the server; players notice it.
			</p>
		{:else}
			<p class="muted small">Start the server to pre-generate chunks.</p>
		{/if}

		<form method="POST" action="?/chunkyAuto" use:enhance class="auto">
			<input type="hidden" name="enabled" value={String(!data.chunky.pauseForPlayers)} />
			<span class="small">
				{#if data.chunky.english}
					{data.chunky.pauseForPlayers
						? 'Pre-generation pauses while anyone is online and continues when the server is empty.'
						: 'Pre-generation runs whether or not anyone is online.'}
				{:else}
					Pausing while players are online needs Chunky set to English (language in config/chunky/config.json):
					MineShell reads which tasks run from its messages.
				{/if}
			</span>
			<button class="button-quiet" disabled={!data.chunky.english && !data.chunky.pauseForPlayers}>
				{data.chunky.pauseForPlayers ? 'Run it regardless' : 'Pause while players are online'}
			</button>
		</form>
		<p class="faint small">
			To run it only at certain hours, add scheduled commands <code>chunky continue</code> and <code>chunky pause</code>
			in <a href="/instances/{encodeURIComponent(data.instance.id)}/settings">server settings</a>.
		</p>
	</section>
{/if}

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
		<SnapshotChoice moves prompt={data.snapshotPrompt} idPrefix="replace" />
		{#if data.running}<p class="hint">Stop the server to replace its world.</p>{/if}
		<button class="button-primary" type="submit" disabled={data.running || busy || uploadPercent !== null}>
			{uploadPercent !== null ? `Uploading ${uploadPercent}%` : 'Upload and replace'}
		</button>
		{#if uploadMessage}<p class="hint">{uploadMessage}</p>{/if}
		{#if uploadError}<p class="hint warn-text">{uploadError}</p>{/if}
	</form>
</section>

{#if data.dimensions.length}
	<section class="panel">
		<div class="panel-head">
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
		<form method="POST" use:enhance={() => async ({ update }) => update({ reset: false })} class="pregen-form">
			<div class="field">
				<label for="prune-dimension">Dimension</label>
				<select id="prune-dimension" name="dimension" bind:value={pruneDimension}>
					{#each data.dimensions as d (d.key)}
						<option value={d.key}>{d.label}</option>
					{/each}
				</select>
			</div>
			<div class="field">
				<label for="prune-ticks">Delete chunks visited less than</label>
				<select id="prune-ticks" name="maxTicks" bind:value={pruneTicks}>
					{#each PRUNE_TICKS as option (option.ticks)}
						<option value={option.ticks}>{option.label}</option>
					{/each}
				</select>
			</div>
			{#if pruneIsOverworld}
				<div class="field">
					<label for="prune-keep">Always keep within (blocks of spawn)</label>
					<input id="prune-keep" name="keepAroundSpawn" type="number" min="0" step="16" bind:value={pruneKeep} />
				</div>
			{/if}
			<button formaction="?/pruneCount" type="submit">Count</button>
		</form>

		{#if countMatches && data.pruneCount}
			<p class="prune-result">
				<strong class="mono">{data.pruneCount.remove.toLocaleString()}</strong> of
				{data.pruneCount.chunks.toLocaleString()} chunks in {data.pruneCount.label} would go, freeing about
				<strong class="mono">{formatBytes(data.pruneCount.bytes)}</strong> of terrain (entities and points of interest
				free a little more).{data.pruneCount.unreadable
					? ` ${data.pruneCount.unreadable.toLocaleString()} could not be read and stay.`
					: ''}
				<span class="faint small">Counted {formatRelative(data.pruneCount.at)}.</span>
			</p>
			<form
				method="POST"
				action="?/prune"
				use:enhance={({ cancel }) => {
					if (!confirm(`Delete ${data.pruneCount?.remove.toLocaleString()} chunks from ${data.pruneCount?.label}?`)) cancel();
				}}
			>
				<input type="hidden" name="dimension" value={pruneDimension} />
				<input type="hidden" name="maxTicks" value={pruneTicks} />
				<input type="hidden" name="keepAroundSpawn" value={pruneIsOverworld ? pruneKeep : 0} />
				<SnapshotChoice moves prompt={data.snapshotPrompt} idPrefix="prune" />
				{#if data.running}<p class="muted small">Stop the server to prune.</p>{/if}
				<button class="button-danger" type="submit" disabled={data.running || busy || data.pruneCount.remove === 0}>
					Prune {data.pruneCount.remove.toLocaleString()} chunks
				</button>
			</form>
		{:else}
			<p class="muted small">Count first: it reads the region files and changes nothing, so it also works while the server runs.</p>
		{/if}
	</section>
{/if}

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

<style>
	.prune-result {
		margin-top: var(--space-4);
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

	.pregen-form {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-3);
	}

	.pregen-form .field {
		margin-bottom: 0;
		flex: 0 1 10rem;
	}

	.pregen-note {
		margin-top: var(--space-2);
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

	.row-actions form {
		/* Pin and Unpin differ in width; a fixed slot keeps every row's buttons in line. */
		min-width: 4.5rem;
		text-align: right;
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
