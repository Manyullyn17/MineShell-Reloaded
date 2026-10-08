<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import Flash from '#lib/components/Flash.svelte';
	import JavaPrompt from '#lib/components/JavaPrompt.svelte';
	import { fitToViewport } from '#lib/shared/fitToViewport.js';
	import { formatBytes, formatDateTime, formatRelative } from '#lib/shared/format.js';

	let { data, form } = $props();

	const map = $derived(data.map);
	const viewUrl = $derived(`/instances/${encodeURIComponent(data.instance.id)}/map/view/`);
	const liveUrl = $derived(`/instances/${encodeURIComponent(data.instance.id)}/map/live/`);
	/** With the BlueMap mod in, which map is shown: BlueMap's render, or the mod's live one. */
	let view = $state<'rendered' | 'live'>('rendered');
	/** Reloaded after each update, so the frame shows the new tiles. */
	const frameKey = $derived(map.settings.lastRenderAt ?? 0);

	// The schedule form, re-synced when the saved one changes.
	let every = $state<'off' | 'interval' | 'daily'>('off');
	let intervalHours = $state(6);
	let dailyTime = $state('05:00');
	$effect(() => {
		every = map.settings.schedule.every;
		intervalHours = map.settings.schedule.intervalHours;
		dailyTime = map.settings.schedule.dailyTime;
	});
	const scheduleChanged = $derived(
		every !== map.settings.schedule.every ||
			(every === 'interval' && intervalHours !== map.settings.schedule.intervalHours) ||
			(every === 'daily' && dailyTime !== map.settings.schedule.dailyTime)
	);
</script>

<Flash {form} />

{#snippet installForm(label: string)}
	<form method="POST" action="?/installMod" use:enhance>
		<button type="submit">{label}</button>
	</form>
{/snippet}

{#if map.support.engine === null}
	<div class="empty">
		<p>{map.support.reason}</p>
	</div>
{:else if map.support.engine === 'dynmap'}
	{#if !map.mods.dynmap}
		<section class="panel setup">
			<h2>A live map with Dynmap</h2>
			<p>
				Minecraft {data.instance.minecraftVersion} worlds are mapped from inside the server: big packs raise the block id limit
				(RoughlyEnoughIDs, JEID), which no outside renderer reads. <strong>Dynmap</strong> draws the map while the server runs and
				keeps it current as the world changes; <strong>DynmapBlockScan</strong> reads the mods' block models so modded blocks are
				drawn instead of left black.
			</p>
			<p class="muted small">
				Installs both (Dynmap from CurseForge, DynmapBlockScan from dynmap.us). They load the next time the server starts; MineShell
				gives Dynmap its own port on this machine only and shows the map here, behind its login.
			</p>
			{@render installForm('Install Dynmap')}
		</section>
	{:else}
		{#if !map.mods.blockScan}
			<div class="notice warning">
				<p>Without DynmapBlockScan, Dynmap draws most modded blocks black.</p>
				{@render installForm('Install DynmapBlockScan')}
			</div>
		{/if}
		{#if map.running}
			<div class="bar">
				<p class="small muted">Dynmap draws what changes as the server runs. A world it has not drawn yet stays empty until it is rendered once.</p>
				<div class="button-row">
					<form method="POST" action="?/dynmapRender" use:enhance><button type="submit">Render the whole world</button></form>
					<a class="button button-quiet" href={liveUrl} target="_blank" rel="noreferrer">Open full screen</a>
				</div>
			</div>
			<iframe class="map" src={liveUrl} title="Map of {data.instance.name}" use:fitToViewport></iframe>
		{:else}
			<div class="empty"><p>Dynmap draws the map while the server runs: start it to see the map.</p></div>
		{/if}
	{/if}
{:else if !map.settings.eulaAccepted}
	<section class="panel setup">
		<h2>A map of the world</h2>
		<p>
			MineShell renders a 3D map of this server's world with <a href="https://bluemap.bluecolored.de/" target="_blank" rel="noreferrer">BlueMap</a>,
			straight from the world files: nothing is added to the server. Modded blocks are drawn from the mods' own models and textures.
			The map is updated when you ask, and shown here, behind MineShell's login.
		</p>
		<p class="muted small">
			BlueMap downloads the Minecraft client from Mojang for the vanilla textures (once, kept in MineShell's data folder), which
			means accepting Mojang's EULA. BlueMap and a Java 21+ runtime are downloaded the first time if they are not here yet.
		</p>
		<form method="POST" action="?/setup" use:enhance>
			<label class="check">
				<input type="checkbox" name="eula" required />
				I accept the <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Minecraft EULA</a>
			</label>
			<JavaPrompt {form} action="setup" />
			<button class="button-primary" type="submit">Render the map</button>
		</form>
	</section>
{:else}
	{#if map.mods.blueMap}
		<nav class="segmented view-switch" aria-label="Which map">
			<button type="button" aria-pressed={view === 'rendered'} onclick={() => (view = 'rendered')}>Rendered</button>
			<button type="button" aria-pressed={view === 'live'} onclick={() => (view = 'live')}>Live (BlueMap mod)</button>
		</nav>
	{/if}
	{#if view === 'live' && map.mods.blueMap}
		{#if map.running}
			<iframe class="map" src={liveUrl} title="Live map of {data.instance.name}" use:fitToViewport></iframe>
		{:else}
			<div class="empty"><p>The BlueMap mod's map runs with the server: start it to see the live map.</p></div>
		{/if}
	{:else}
	<div class="bar">
		<p class="small muted">
			{#if map.taskId}
				Updating now - follow it in Tasks.
			{:else if map.settings.lastRenderAt}
				Updated <span title={formatDateTime(map.settings.lastRenderAt)}>{formatRelative(map.settings.lastRenderAt)}</span>
				· {formatBytes(map.sizeBytes)}
			{:else}
				Not rendered yet.
			{/if}
		</p>
		<div class="button-row">
			<form method="POST" action="?/render" use:enhance>
				<JavaPrompt {form} action="render" />
				<button type="submit" disabled={!!map.taskId}>{map.ready ? 'Update map' : 'Render the map'}</button>
			</form>
			{#if map.ready && !map.taskId}
				<a class="button button-quiet" href={viewUrl} target="_blank" rel="noreferrer">Open full screen</a>
				<form
					method="POST"
					action="?/delete"
					use:enhance={({ cancel }) => {
						if (!confirm('Delete the rendered map? The world is not touched; the next update renders it all again.')) cancel();
					}}
				>
					<button type="submit" class="button-quiet button-danger">Delete map data</button>
				</form>
			{/if}
		</div>
	</div>

	<form method="POST" action="?/schedule" use:enhance={() => async ({ update }) => update({ reset: false })} class="schedule small">
		<label for="map-every">Update automatically</label>
		<select id="map-every" name="every" bind:value={every}>
			<option value="off">No, only when I ask</option>
			<option value="interval">Every few hours</option>
			<option value="daily">Daily</option>
		</select>
		{#if every === 'interval'}
			<label class="inline">every <input name="intervalHours" type="number" min="1" max="168" bind:value={intervalHours} class="hours" /> h</label>
		{:else if every === 'daily'}
			<label class="inline">at <input name="dailyTime" type="time" bind:value={dailyTime} /></label>
		{/if}
		{#if scheduleChanged}<button type="submit" class="button-quiet">Save</button>{/if}
		{#if map.settings.schedule.every !== 'off' && map.settings.nextAt && !scheduleChanged}
			<span class="muted">next {formatRelative(map.settings.nextAt)}</span>
		{/if}
	</form>

	{#if map.ready}
		{#key frameKey}
			<iframe class="map" src={viewUrl} title="Map of {data.instance.name}" use:fitToViewport></iframe>
		{/key}
	{:else}
		<div class="empty">
			<p>{map.taskId ? 'The first render is running; the map shows here when it is done.' : 'Nothing rendered yet.'}</p>
		</div>
	{/if}
	{#if !map.mods.blueMap}
		<div class="live-offer small">
			<span class="muted">Want it live, with players on it? The BlueMap mod updates the map as the world changes, while the server runs.</span>
			{@render installForm('Add the BlueMap mod')}
		</div>
	{/if}
	{/if}
{/if}

<style>
	.setup {
		max-width: 46rem;
	}

	.setup form {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-3);
		margin-top: var(--space-3);
	}

	.check {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2) var(--space-4);
		margin-bottom: var(--space-3);
	}

	.bar p {
		margin: 0;
	}

	/* As tall as the screen; fitToViewport's max-height trims it to the room left. */
	.schedule {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin: 0 0 var(--space-3);
	}

	.schedule .inline {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		margin: 0;
	}

	.hours {
		width: 4.5rem;
	}

	.segmented {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 2px;
		padding: 3px;
		background: var(--bg-sunken);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-lg);
	}

	.segmented button {
		border: 0;
		padding: 0.3rem 0.75rem;
		font-weight: 400;
		background: transparent;
		color: var(--text-muted);
	}

	.segmented button[aria-pressed='true'] {
		background: var(--panel-raised);
		color: var(--text);
	}

	.view-switch {
		margin-bottom: var(--space-3);
	}

	.live-offer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		margin-top: var(--space-3);
	}

	.notice form {
		margin-top: var(--space-2);
	}

	.map {
		display: block;
		width: 100%;
		height: 100vh;
		min-height: 24rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		background: #000;
	}
</style>
