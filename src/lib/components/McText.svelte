<script lang="ts">
	import { colorHex, glyphWidth, obfuscatedGlyph, textWidth, type Span } from '#lib/shared/mctext.js';

	/**
	 * Formatted Minecraft text (mctext.ts) in its colours and styles. `measured` (one line)
	 * squeezes or stretches it to the width it has in the game's font, in units of `--mc-px`
	 * set by the parent, so it is as long as in game whatever font the browser draws it in.
	 */
	let { spans, measured = false }: { spans: Span[]; measured?: boolean } = $props();
	let target = $state(0);
	let natural = $state(0);

	// Obfuscated text: a random glyph of the same width for each character, as the game draws it,
	// in a box that width so the line does not move. The game picks anew every frame; 20 times a
	// second reads the same (nothing legible) without keeping the page busy.
	let tick = $state(0);
	const obfuscated = $derived(spans.some((s) => s.obfuscated));
	$effect(() => {
		if (!obfuscated) return;
		const timer = setInterval(() => tick++, 50);
		return () => clearInterval(timer);
	});

	function scrambled(text: string): string[] {
		void tick;
		return [...text].map(obfuscatedGlyph);
	}

	function styleOf(span: Span): string {
		const color = colorHex(span.color);
		return color ? `color: ${color}` : '';
	}
</script>

{#snippet text()}{#each spans as span, i (i)}<span
			class="mc"
			class:bold={span.bold}
			class:italic={span.italic}
			class:underlined={span.underlined}
			class:strikethrough={span.strikethrough}
			style={styleOf(span)}
			>{#if span.obfuscated}{#each scrambled(span.text) as glyph, j (j)}<span class="glyph" style="--g: {glyphWidth([...span.text][j], span.bold)}">{glyph}</span
					>{/each}{:else}{span.text}{/if}</span
		>{/each}{/snippet}

{#if measured}
	<span class="measured" style="--w: {textWidth(spans)}" bind:clientWidth={target}
		><span class="natural" bind:offsetWidth={natural} style="transform: scaleX({natural ? target / natural : 1})">{@render text()}</span></span
	>
{:else}
	{@render text()}
{/if}

<style>
	.mc {
		white-space: pre-wrap;
	}
	.bold {
		font-weight: 700;
	}
	.italic {
		font-style: italic;
	}
	.underlined {
		text-decoration: underline;
	}
	.strikethrough {
		text-decoration: line-through;
	}
	.underlined.strikethrough {
		text-decoration: underline line-through;
	}
	/* One game pixel is an eighth of the font size (the game's font is 8 high). */
	.glyph {
		display: inline-block;
		width: calc(var(--g) * 0.125em);
		text-align: center;
	}
	.measured {
		display: inline-block;
		width: calc(var(--w) * var(--mc-px, 1px));
		white-space: pre;
		/* Centred text around it (the resource pack prompt) centred the unscaled text in here
		   first, and the stretch from its left edge then pushed it right. */
		text-align: left;
	}
	.natural {
		display: inline-block;
		transform-origin: left;
		white-space: pre;
	}
</style>
