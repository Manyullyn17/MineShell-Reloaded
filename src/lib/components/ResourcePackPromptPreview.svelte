<script lang="ts">
	import McText from './McText.svelte';
	import { parseCodes, wrapLines, type Span } from '#lib/shared/mctext.js';
	import { buttonGrain, dirtGrain } from '#lib/shared/mcdraw.js';

	/**
	 * The question a joining player gets about the server resource pack. The game asks its own
	 * question and puts the server's prompt under it ("multiplayer.texturePrompt.serverPrompt":
	 * `%s\n\nMessage from server:\n%s`, the same from 1.17 to 26.3); required, the question is
	 * yellow and bold and the buttons change. Lines broken as the confirm screen breaks them in the
	 * game's default window (854 x 480 at GUI scale 2: 427 wide, the message 50 less). Drawn in the
	 * previews' pixel font, over a stand-in for what the version shows behind menus (a blurred
	 * world from 1.20.5, darkened dirt before), with buttons like the game's but not its texture.
	 */
	let { prompt, required, menuBlur }: { prompt: string; required: boolean; menuBlur: boolean } = $props();

	const MESSAGE_WIDTH = 377;
	const title = $derived(
		required ? 'This server requires the use of a custom resource pack.' : 'This server recommends the use of a custom resource pack.'
	);
	const lines = $derived.by(() => {
		const question: Span = required
			? { text: 'Rejecting this custom resource pack will disconnect you from this server.', color: 'yellow', bold: true }
			: { text: 'Would you like to download and install it automagically?' };
		const spans: Span[] = [question];
		if (prompt.trim()) spans.push({ text: '\n\nMessage from server:\n' }, ...parseCodes(prompt));
		return wrapLines(spans, MESSAGE_WIDTH);
	});
	const buttons = $derived(required ? ['Proceed', 'Disconnect'] : ['Yes', 'No']);

	let textures = $state({ button: '', dirt: '' });
	$effect(() => {
		textures = { button: buttonGrain(), dirt: menuBlur ? '' : dirtGrain(false) };
	});
</script>

<div class="frame">
	<div
		class="screen"
		class:blur={menuBlur}
		style:background-image={textures.dirt ? `url(${textures.dirt})` : undefined}
		style:--grain={textures.button ? `url(${textures.button})` : undefined}
		aria-label="Preview of what joining players are asked"
	>
		<p class="line title"><McText spans={[{ text: title }]} measured /></p>
		{#each lines as line, i (i)}
			<p class="line"><McText spans={line} measured /></p>
		{/each}
		<div class="buttons" aria-hidden="true">
			{#each buttons as label (label)}<span class="mc-button"><McText spans={[{ text: label }]} measured /></span>{/each}
		</div>
	</div>
</div>

<style>
	.frame {
		container-type: inline-size;
		max-width: 854px;
		margin-top: var(--space-1);
	}
	.screen {
		/* One game pixel: 2 CSS px, or less where the column is narrower than the screen. */
		--mc-px: min(2px, calc(100cqw / 427));
		position: relative;
		width: calc(427 * var(--mc-px));
		padding: calc(12 * var(--mc-px)) 0;
		/* Before 1.20.5: the menus' dirt, darkened, 16 texels of 2 game px each. */
		background-color: #281d14;
		background-size: calc(32 * var(--mc-px)) calc(32 * var(--mc-px));
		image-rendering: pixelated;
		border: 1px solid #3a3a3e;
		font-family: var(--font-mc);
		font-size: calc(8 * var(--mc-px));
		/* The font's own height, so a line's pixels start at its top; lines are 9 apart. */
		line-height: calc(8 * var(--mc-px));
		color: #ffffff;
		text-align: center;
		white-space: nowrap;
		overflow: hidden;
		box-sizing: content-box;
	}
	/* From 1.20.5: whatever is behind the menu, blurred; a stand-in, since that is the player's world. */
	.screen.blur::before {
		content: '';
		position: absolute;
		inset: calc(-30 * var(--mc-px));
		background:
			radial-gradient(40% 55% at 18% 30%, #6b5a36 0%, transparent 70%),
			radial-gradient(35% 50% at 72% 65%, #7a5a32 0%, transparent 70%),
			radial-gradient(30% 40% at 86% 18%, #56708a 0%, transparent 70%),
			radial-gradient(45% 60% at 40% 92%, #3f4a2c 0%, transparent 70%),
			#3b3a30;
		filter: blur(calc(10 * var(--mc-px))) brightness(0.8);
	}
	.screen > * {
		position: relative;
	}
	.line {
		margin: 0;
		/* The blank line before "Message from server:" keeps its height. */
		height: calc(9 * var(--mc-px));
	}
	.title {
		margin-bottom: calc(8 * var(--mc-px));
	}
	.buttons {
		display: flex;
		justify-content: center;
		gap: calc(5 * var(--mc-px));
		margin-top: calc(23 * var(--mc-px));
	}
	/* Not .button: that is the site's own button look, a pointer and a hover outline on what does nothing. */
	.mc-button {
		width: calc(150 * var(--mc-px));
		height: calc(20 * var(--mc-px));
		box-sizing: border-box;
		/* The label's pixels start 6 down, as the game centres 8 in 20. */
		padding-top: calc(5 * var(--mc-px));
		border: var(--mc-px) solid #000000;
		background-color: #6f6f6f;
		background-image: var(--grain);
		background-size: calc(16 * var(--mc-px)) calc(16 * var(--mc-px));
		box-shadow:
			inset var(--mc-px) var(--mc-px) 0 #a2a2a2,
			inset calc(-1 * var(--mc-px)) calc(-2 * var(--mc-px)) 0 #555555;
	}
</style>
