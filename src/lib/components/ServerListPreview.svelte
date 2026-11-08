<script lang="ts">
	import McText from './McText.svelte';
	import ServerIcon from './ServerIcon.svelte';
	import { parseCodes, wrapLines } from '#lib/shared/mctext.js';

	/**
	 * The server as the multiplayer list draws it, from the 26.3 client's ServerSelectionList:
	 * a 305 px row, the 32 px icon, the name at 35, the description broken to 267 px (the row's
	 * content less the icon and gaps) with at most two lines shown, grey where it sets no colour.
	 * Drawn at up to 2 CSS px a game pixel, smaller where the column is narrower.
	 */
	let {
		motd,
		name,
		instanceId,
		iconVersion,
		maxPlayers
	}: { motd: string; name: string; instanceId: string; iconVersion: number | null; maxPlayers: number } = $props();

	const MOTD_WIDTH = 267;
	const lines = $derived(wrapLines(parseCodes(motd), MOTD_WIDTH));
</script>

<div class="frame">
	<div class="row" aria-label="Preview of the server in the multiplayer list">
		<span class="icon"><ServerIcon id={instanceId} {name} {iconVersion} size={32} /></span>
		<span class="name"><McText spans={[{ text: name }]} measured /></span>
		<span class="players"
			><McText spans={[{ text: '0', color: 'gray' }, { text: '/', color: 'dark_gray' }, { text: String(maxPlayers), color: 'gray' }]} measured /></span
		>
		<span class="ping" aria-hidden="true">{#each [2, 3, 4, 6, 8] as h (h)}<i style="--h: {h}"></i>{/each}</span>
		{#each lines.slice(0, 2) as line, i (i)}
			<span class="motd" style="--line: {i}"><McText spans={line} measured /></span>
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
		background: #101012;
		border: 1px solid #3a3a3e;
		font-size: calc(8 * var(--mc-px));
		line-height: calc(9 * var(--mc-px));
		color: #808080;
		overflow: hidden;
		white-space: nowrap;
		box-sizing: content-box;
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
	.icon :global(.server-icon) {
		width: 100%;
		height: 100%;
	}
	.name {
		left: calc(37 * var(--mc-px));
		top: calc(3 * var(--mc-px));
		color: #ffffff;
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
		background: #55ff55;
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
