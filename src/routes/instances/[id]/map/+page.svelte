<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import Flash from '#lib/components/Flash.svelte';
	import JavaPrompt from '#lib/components/JavaPrompt.svelte';
	import { fitToViewport } from '#lib/shared/fitToViewport.js';
	import { formatBytes, formatDateTime, formatRelative } from '#lib/shared/format.js';

	let { data, form } = $props();

	const map = $derived(data.map);
	const viewUrl = $derived(`/instances/${encodeURIComponent(data.instance.id)}/map/view/`);
	/** Reloaded after each update, so the frame shows the new tiles. */
	const frameKey = $derived(map.settings.lastRenderAt ?? 0);
</script>

<Flash {form} />

{#if map.support.engine === null}
	<div class="empty">
		<p>{map.support.reason}</p>
	</div>
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

	{#if map.ready}
		{#key frameKey}
			<iframe class="map" src={viewUrl} title="Map of {data.instance.name}" use:fitToViewport></iframe>
		{/key}
	{:else}
		<div class="empty">
			<p>{map.taskId ? 'The first render is running; the map shows here when it is done.' : 'Nothing rendered yet.'}</p>
		</div>
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
