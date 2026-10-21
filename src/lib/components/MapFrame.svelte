<script lang="ts">
	import { onMount } from 'svelte';
	import { fitToViewport } from '#lib/shared/fitToViewport.js';

	/**
	 * A map's own page (BlueMap's web app, a map mod's page) in a sandboxed
	 * frame under its token (mapframe.ts): an origin of its own, so its scripts
	 * reach nothing of MineShell's. What it keeps in localStorage and cookies
	 * lives in memory there; this keeps it in MineShell's own localStorage
	 * between visits and hands it back through the frame's name.
	 */
	let { src, title, full = false }: { src: string; title: string; full?: boolean } = $props();

	const KEY = 'mineshell:map-storage';
	const PREFIX = 'mineshell-map:';
	/** More than the maps keep (BlueMap: a few hundred bytes); a page sending more is not stored. */
	const MAX_BYTES = 100_000;

	let frame = $state<HTMLIFrameElement>();
	// Only in the browser: the frame's name has to carry what was saved before it loads.
	let mounted = $state(false);
	onMount(() => (mounted = true));

	function saved(): Record<string, string> {
		try {
			const kept = localStorage.getItem(KEY);
			if (kept) return JSON.parse(kept);
			// What BlueMap kept while maps ran on MineShell's own address (before 0.31).
			return Object.fromEntries(
				Object.keys(localStorage)
					.filter((key) => key.startsWith('bluemap-'))
					.map((key) => [key, localStorage.getItem(key) ?? ''])
			);
		} catch {
			return {};
		}
	}

	function onmessage(event: MessageEvent) {
		if (!frame || event.source !== frame.contentWindow) return;
		const storage = event.data?.mineshellMap?.storage;
		if (!storage || typeof storage !== 'object') return;
		const text = JSON.stringify(Object.fromEntries(Object.entries(storage).filter(([, value]) => typeof value === 'string')));
		if (text.length > MAX_BYTES) return;
		try {
			localStorage.setItem(KEY, text);
		} catch {
			// Private windows and full storage: the map just forgets its settings.
		}
	}
</script>

<svelte:window {onmessage} />

{#if !mounted}
	<div class="map" class:full></div>
{:else if full}
	<iframe
		bind:this={frame}
		class="map full"
		{src}
		{title}
		name={PREFIX + JSON.stringify(saved())}
		sandbox="allow-scripts allow-forms allow-popups allow-downloads"
		allow="fullscreen; clipboard-write"
	></iframe>
{:else}
	<iframe
		bind:this={frame}
		class="map"
		{src}
		{title}
		name={PREFIX + JSON.stringify(saved())}
		sandbox="allow-scripts allow-forms allow-popups allow-downloads"
		allow="fullscreen; clipboard-write"
		use:fitToViewport
	></iframe>
{/if}

<style>
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

	.map.full {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100vh;
		min-height: 0;
		border: 0;
		border-radius: 0;
	}
</style>
