<script lang="ts">
	import { serverHue, serverInitials } from '#lib/shared/servertile.js';

	/**
	 * A server's icon (its server-icon.png, drawn pixelated), or its initials on
	 * a colour made from its name. `iconVersion` is the icon's modification time,
	 * null without one: it is in the address, so a changed icon is fetched again
	 * and an unchanged one comes from the browser's cache.
	 */
	let { id, name, iconVersion, size = 20 }: { id: string; name: string; iconVersion: number | null; size?: number } = $props();
	let failed = $state(false);
	$effect(() => {
		void iconVersion;
		failed = false;
	});
</script>

{#if iconVersion !== null && !failed}
	<img
		class="server-icon"
		src="/api/instances/{encodeURIComponent(id)}/icon?v={iconVersion}"
		alt=""
		width={size}
		height={size}
		onerror={() => (failed = true)}
	/>
{:else}
	<span class="server-icon tile" style="--size: {size}px; --hue: {serverHue(name)}" aria-hidden="true">{serverInitials(name)}</span>
{/if}

<style>
	.server-icon {
		flex: none;
		border-radius: 4px;
		image-rendering: pixelated;
	}

	.tile {
		display: inline-grid;
		place-items: center;
		width: var(--size);
		height: var(--size);
		/* One lightness and chroma for every hue, so no name gets a tile that is hard to read; works on both themes. */
		background: oklch(0.56 0.13 var(--hue));
		color: #fff;
		font-weight: 700;
		font-size: calc(var(--size) * 0.42);
		line-height: 1;
		letter-spacing: -0.02em;
		user-select: none;
	}
</style>
