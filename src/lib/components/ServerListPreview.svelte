<script lang="ts">
	import McText from './McText.svelte';
	import ServerIcon from './ServerIcon.svelte';
	import { parseCodes, wrapLines } from '#lib/shared/mctext.js';
	import { dirtGrain, drawDefaultIcon } from '#lib/shared/mcdraw.js';

	/**
	 * The server as the multiplayer list draws it, from the 26.3 client's ServerSelectionList:
	 * a 305 px row, the 32 px icon, the name at 35, the description broken to 267 px (the row's
	 * content less the icon and gaps) with at most two lines shown, grey where it sets no colour.
	 * Drawn in the previews' pixel font at up to 2 CSS px a game pixel, smaller where the column
	 * is narrower; behind it a stand-in for what the version shows (a blurred world from 1.20.5,
	 * dark dirt before), and for a server without an icon a stand-in for the game's default one.
	 */
	let {
		motd,
		name,
		instanceId,
		iconVersion,
		maxPlayers,
		menuBlur
	}: { motd: string; name: string; instanceId: string; iconVersion: number | null; maxPlayers: number; menuBlur: boolean } = $props();

	const MOTD_WIDTH = 267;
	const GREY = '#808080';
	const lines = $derived(wrapLines(parseCodes(motd), MOTD_WIDTH));

	let dirt = $state('');
	$effect(() => {
		dirt = menuBlur ? '' : dirtGrain(true);
	});
	const defaultIcon = (canvas: HTMLCanvasElement) => drawDefaultIcon(canvas);
</script>

<div class="frame">
	<div
		class="row"
		class:blur={menuBlur}
		style:background-image={dirt ? `url(${dirt})` : undefined}
		aria-label="Preview of the server in the multiplayer list"
	>
		<span class="icon">
			{#if iconVersion !== null}
				<ServerIcon id={instanceId} {name} {iconVersion} size={32} />
			{:else}
				<canvas use:defaultIcon aria-hidden="true"></canvas>
			{/if}
		</span>
		<span class="name"><McText spans={[{ text: name }]} measured /></span>
		<span class="players"><McText spans={[{ text: `0/${maxPlayers}` }]} base={GREY} measured /></span>
		<span class="ping" aria-hidden="true">{#each [2, 3, 4, 5, 7] as h (h)}<i style="--h: {h}"></i>{/each}</span>
		{#each lines.slice(0, 2) as line, i (i)}
			<span class="motd" style="--line: {i}"><McText spans={line} base={GREY} measured /></span>
		{/each}
	</div>
</div>
{#if lines.length > 2}
	<p class="small warn-text">The list shows two lines: the rest of the description is cut off.</p>
{/if}

<style>
	.frame {
		container-type: inline-size;
		max-width: 610px;
		margin-top: var(--space-1);
	}
	.row {
		/* One game pixel: 2 CSS px, or less where the column is narrower than the row. */
		--mc-px: min(2px, calc(100cqw / 305));
		position: relative;
		width: calc(305 * var(--mc-px));
		height: calc(36 * var(--mc-px));
		/* Before 1.20.5: the list's dark dirt, 16 texels of 2 game px each. */
		background-color: #16100b;
		background-size: calc(32 * var(--mc-px)) calc(32 * var(--mc-px));
		image-rendering: pixelated;
		font-family: var(--font-mc);
		font-size: calc(8 * var(--mc-px));
		/* The font's own height, so a line's pixels start at its top. */
		line-height: calc(8 * var(--mc-px));
		color: #ffffff;
		overflow: hidden;
		white-space: nowrap;
		box-sizing: content-box;
	}
	/* From 1.20.5: whatever is behind the menu, blurred and darkened; a stand-in, since that is the player's world. */
	.row.blur::before {
		content: '';
		position: absolute;
		inset: calc(-20 * var(--mc-px));
		background:
			radial-gradient(40% 60% at 20% 30%, #5d6b3a 0%, transparent 70%),
			radial-gradient(35% 55% at 70% 60%, #7a5a32 0%, transparent 70%),
			radial-gradient(30% 45% at 88% 15%, #56708a 0%, transparent 70%),
			#3b3a30;
		filter: blur(calc(6 * var(--mc-px))) brightness(0.7);
	}
	.row > span {
		position: absolute;
	}
	.icon {
		left: calc(2 * var(--mc-px));
		top: calc(2 * var(--mc-px));
		width: calc(32 * var(--mc-px));
		height: calc(32 * var(--mc-px));
	}
	.icon :global(.server-icon),
	.icon canvas {
		display: block;
		width: 100%;
		height: 100%;
		border-radius: 0;
		image-rendering: pixelated;
	}
	.name {
		left: calc(37 * var(--mc-px));
		top: calc(3 * var(--mc-px));
	}
	.players {
		right: calc(19 * var(--mc-px));
		top: calc(3 * var(--mc-px));
	}
	.ping {
		right: calc(4 * var(--mc-px));
		top: calc(2 * var(--mc-px));
		height: calc(8 * var(--mc-px));
		display: flex;
		align-items: flex-end;
		gap: calc(1 * var(--mc-px));
	}
	.ping i {
		width: calc(1 * var(--mc-px));
		height: calc(var(--h) * var(--mc-px));
		background: #00ff21;
		box-shadow: var(--mc-px) var(--mc-px) 0 #004008;
	}
	.motd {
		left: calc(37 * var(--mc-px));
		top: calc((14 + 9 * var(--line)) * var(--mc-px));
	}
	.warn-text {
		color: var(--warning);
		margin-top: var(--space-1);
	}
</style>
