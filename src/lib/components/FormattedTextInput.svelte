<script lang="ts">
	import { tick } from 'svelte';
	import { codesFor, COLORS, FORMATS, styleAt } from '#lib/shared/mctext.js';

	/**
	 * A text box for Minecraft's formatted text (mctext.ts), with buttons that put colour and
	 * format codes in. With text selected, a code applies to the selection: the style after it
	 * is put back. `hex` offers any colour (`§#rrggbb`), for places stored as JSON or NBT text.
	 */
	let {
		id,
		name,
		value = $bindable(''),
		multiline = false,
		rows = 2,
		hex = false,
		disabled = false,
		placeholder = '',
		labelledby
	}: {
		id: string;
		name?: string;
		value?: string;
		multiline?: boolean;
		rows?: number;
		hex?: boolean;
		disabled?: boolean;
		placeholder?: string;
		labelledby?: string;
	} = $props();

	let box = $state<HTMLInputElement | HTMLTextAreaElement>();
	let picked = $state('#ff8800');

	async function insert(code: string) {
		if (!box || disabled) return;
		const start = box.selectionStart ?? value.length;
		const end = box.selectionEnd ?? start;
		// A selection keeps what follows it as it was.
		const after = end > start ? codesFor(styleAt(value.slice(0, end))) : '';
		value = value.slice(0, start) + code + value.slice(start, end) + after + value.slice(end);
		await tick();
		const at = end + code.length + after.length;
		box.focus();
		box.setSelectionRange(at, at);
	}

	const LABELS: Record<string, string> = { l: 'B', o: 'I', n: 'U', m: 'S', k: '?' };
</script>

<div class="formatted">
	<div class="codes" role="toolbar" aria-label="Colours and formats" aria-controls={id}>
		{#each COLORS as color (color.code)}
			<button
				type="button"
				class="swatch hit-area"
				style="--swatch: {color.hex}"
				title="{color.name.replace('_', ' ')} (§{color.code})"
				aria-label={color.name.replace('_', ' ')}
				{disabled}
				onclick={() => insert(`§${color.code}`)}
			></button>
		{/each}
		{#if hex}
			<span class="hex">
				<input type="color" bind:value={picked} aria-label="Any colour" {disabled} />
				<button type="button" class="format hit-area" title="Use this colour" {disabled} onclick={() => insert(`§${picked.toLowerCase()}`)}>Use</button>
			</span>
		{/if}
		<span class="formats">
			{#each FORMATS as format (format.code)}
				<button
					type="button"
					class="format hit-area {format.key}"
					title="{format.label} (§{format.code})"
					aria-label={format.label}
					{disabled}
					onclick={() => insert(`§${format.code}`)}>{LABELS[format.code]}</button
				>
			{/each}
			<button type="button" class="format hit-area" title="Plain again (§r)" aria-label="Plain again" {disabled} onclick={() => insert('§r')}>R</button>
		</span>
	</div>
	{#if multiline}
		<textarea bind:this={box} {id} {name} autocomplete="off" {rows} bind:value {disabled} {placeholder} aria-labelledby={labelledby}></textarea>
	{:else}
		<input bind:this={box} {id} {name} autocomplete="off" bind:value {disabled} {placeholder} aria-labelledby={labelledby} />
	{/if}
</div>

<style>
	.formatted {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}
	.codes {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 3px;
	}
	.swatch {
		width: 1.1rem;
		height: 1.1rem;
		padding: 0;
		border: 1px solid var(--line-strong);
		border-radius: 3px;
		background: var(--swatch);
	}
	.formats,
	.hex {
		display: inline-flex;
		gap: 3px;
		margin-left: var(--space-2);
	}
	.format {
		min-width: 1.6rem;
		height: 1.4rem;
		padding: 0 var(--space-1);
		font-size: 0.8rem;
		line-height: 1;
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
	.hex input[type='color'] {
		width: 1.6rem;
		height: 1.4rem;
		padding: 0;
		border: 1px solid var(--line-strong);
		background: none;
	}
	textarea,
	input {
		font-family: var(--font-mono);
	}
</style>
