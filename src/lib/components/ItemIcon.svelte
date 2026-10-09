<script lang="ts">
	import type { iconLoader } from '#lib/shared/itemicon.svelte.js';

	/**
	 * An item's picture (lib/shared/itemicon.svelte.ts), or nothing while it
	 * loads or when there is none - the caller keeps its text then. A variant
	 * MineShell had to guess is marked.
	 */
	let {
		loader,
		id,
		damage = null,
		size = 32,
		onresult
	}: {
		loader: ReturnType<typeof iconLoader>;
		id: string;
		damage?: number | null;
		size?: number;
		/** Whether a picture is shown, so the caller can hide its text; a 1.12 variant's own name if known. */
		onresult?: (shown: boolean, name: string | null) => void;
	} = $props();

	let url = $state<string | null>(null);
	let exact = $state(true);

	$effect(() => {
		void loader.version;
		const key = `${id}@${damage}`;
		let live = true;
		url = null;
		loader.icon(id, damage).then((icon) => {
			if (!live || `${id}@${damage}` !== key) return;
			url = icon.url;
			exact = icon.exact;
			onresult?.(!!icon.url, icon.name);
		});
		return () => {
			live = false;
		};
	});
</script>

{#if url}
	<span class="icon" style:width="{size}px" style:height="{size}px">
		<img src={url} alt="" width={size} height={size} />
		{#if !exact}<span class="guess" title="A guess: which variant this damage value stands for is in the mod's code">?</span>{/if}
	</span>
{/if}

<style>
	.icon {
		position: relative;
		display: inline-block;
		flex: none;
	}

	img {
		display: block;
		image-rendering: pixelated;
	}

	.guess {
		position: absolute;
		right: -2px;
		top: -4px;
		font-size: 0.65rem;
		font-weight: 600;
		line-height: 1;
		color: var(--warning);
		text-shadow: 0 0 2px var(--bg);
	}
</style>
