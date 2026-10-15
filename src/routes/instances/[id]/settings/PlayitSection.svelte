<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import { streamed } from '#lib/shared/streamed.svelte.js';
	import SettingsSection from '#lib/components/SettingsSection.svelte';
	import type { PageData } from './$types';

	let {
		instanceId,
		playit: info,
		voice,
		serverPort,
		editable
	}: {
		instanceId: string;
		playit: PageData['playit'];
		voice: PageData['voice'];
		serverPort: number;
		editable: boolean;
	} = $props();

	const playitInfo = streamed(() => info.status, () => instanceId);
	const playit = $derived(playitInfo.ready ? playitInfo.value : null);
	let playitRegion = $state('global');
</script>

<SettingsSection
	tab="network"
	title="Public address (playit.gg)"
	{editable}
	description="Players outside your network join through playit.gg, without port forwarding."
>
	{#if !info.linked}
		<p class="hint">
			Link playit.gg first, in <a href="/settings?tab=integrations">MineShell settings, Integrations</a>.
		</p>
	{:else if info.tunnel}
		<div class="rows">
			<div class="field">
				<span class="label">Address players type</span>
				{#if !playit}
					<p class="hint">Asking playit.gg...</p>
				{:else if playit.address?.address}
					<code class="public-address">{playit.address.address}</code>
					<p class="hint">
						Through playit.gg to port {serverPort}{info.tunnel.region !== 'global'
							? `, region ${info.regions.find((r) => r.id === info.tunnel?.region)?.label ?? info.tunnel.region}`
							: ''}. Follows the game port when the server starts. A new address can take a few minutes before it
						works everywhere.
					</p>
				{:else}
					<p class="hint">playit.gg is still setting up the address; it shows up here in a moment.</p>
				{/if}
				{#if voice}
					<p class="hint">
						{#if playit?.address?.voice}
							Voice chat: <code class="mono">{playit.address.voice}</code> (its own UDP tunnel), written into the mod's
							voice_host{voice.host === playit.address.voice ? '' : '; applies on the next restart'}.
						{:else}
							Voice chat gets its own UDP tunnel, and the mod is told its address when the server next starts.
						{/if}
					</p>
				{/if}
				{#if playit && !playit.running}
					<p class="hint warn-text">The playit agent is not running or not connected, so the address does not answer; see MineShell settings, Integrations.</p>
				{/if}
			</div>
		</div>
		<form
			method="POST"
			action="?/playitPrivate"
			use:enhance
			class="button-row"
			onsubmit={(e) => {
				if (!confirm('Stop being public? The tunnel is deleted; switching on again gives a new address.')) e.preventDefault();
			}}
		>
			<button class="button-quiet" type="submit">Stop being public</button>
		</form>
	{:else}
		<form method="POST" action="?/playitPublic" use:enhance class="rows">
			<div class="field">
				<label for="playit-region">Region</label>
				<select id="playit-region" name="region" bind:value={playitRegion}>
					{#each info.regions as region (region.id)}
						<option value={region.id} disabled={region.premium && !playit?.premium}>
							{region.label}{region.premium && !playit?.premium ? ' (needs playit Premium)' : ''}
						</option>
					{/each}
				</select>
				<p class="hint">
					Where the public address lives. Global picks the nearest playit location for each player; a fixed
					region, a dedicated IP and your own domain are playit Premium (dedicated IPs and domains are set up on
					playit.gg).
				</p>
			</div>
			<div class="button-row">
				<button class="button-primary" type="submit">Make public</button>
			</div>
		</form>
	{/if}
</SettingsSection>

<style>
	.public-address {
		font-size: 1rem;
		user-select: all;
	}

	.warn-text {
		color: var(--warning);
	}
</style>
