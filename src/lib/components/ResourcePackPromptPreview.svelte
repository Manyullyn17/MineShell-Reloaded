<script lang="ts">
	import McText from './McText.svelte';
	import { parseCodes, wrapLines, type Span } from '#lib/shared/mctext.js';

	/**
	 * The question a joining player gets about the server resource pack. The game asks its own
	 * question and puts the server's prompt under it ("multiplayer.texturePrompt.serverPrompt":
	 * `%s\n\nMessage from server:\n%s`, the same from 1.17 to 1.21.11), required or not changing
	 * the question and the buttons. Lines broken as the confirm screen breaks them in the game's
	 * default window (854 x 480 at GUI scale 2: 427 wide, the message 50 less).
	 */
	let { prompt, required }: { prompt: string; required: boolean } = $props();

	const MESSAGE_WIDTH = 377;
	const title = $derived(
		required ? 'This server requires the use of a custom resource pack.' : 'This server recommends the use of a custom resource pack.'
	);
	const lines = $derived.by(() => {
		const question = required
			? 'Rejecting this custom resource pack will disconnect you from this server.'
			: 'Would you like to download and install it automagically?';
		const spans: Span[] = [{ text: question }];
		if (prompt.trim()) spans.push({ text: '\n\nMessage from server:\n' }, ...parseCodes(prompt));
		return wrapLines(spans, MESSAGE_WIDTH);
	});
	const buttons = $derived(required ? ['Proceed', 'Disconnect'] : ['Yes', 'No']);
</script>

<div class="frame">
	<div class="screen" aria-label="Preview of what joining players are asked">
		<p class="line title"><McText spans={[{ text: title }]} measured /></p>
		{#each lines as line, i (i)}
			<p class="line"><McText spans={line} measured /></p>
		{/each}
		<div class="buttons" aria-hidden="true">
			{#each buttons as label (label)}<span class="button"><McText spans={[{ text: label }]} measured /></span>{/each}
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
		width: calc(427 * var(--mc-px));
		padding: calc(12 * var(--mc-px)) 0;
		background: #1b1b1f;
		border: 1px solid #3a3a3e;
		font-size: calc(8 * var(--mc-px));
		line-height: calc(9 * var(--mc-px));
		color: #ffffff;
		text-align: center;
		white-space: nowrap;
		overflow: hidden;
		box-sizing: content-box;
	}
	.line {
		margin: 0;
		/* The blank line before "Message from server:" keeps its height. */
		min-height: calc(9 * var(--mc-px));
	}
	.title {
		margin-bottom: calc(9 * var(--mc-px));
	}
	.buttons {
		display: flex;
		justify-content: center;
		gap: calc(10 * var(--mc-px));
		margin-top: calc(14 * var(--mc-px));
	}
	.button {
		width: calc(150 * var(--mc-px));
		line-height: calc(20 * var(--mc-px));
		background: #6f6f6f;
		border: calc(1 * var(--mc-px)) solid #000000;
	}
</style>
