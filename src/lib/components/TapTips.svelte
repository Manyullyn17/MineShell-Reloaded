<script lang="ts">
	/**
	 * Touch screens have no hover, so a `title` (why a mod is client-only or off
	 * for Cleanroom, which Java a server uses, what a disk usage bar is) was
	 * unreadable on a phone. There, tapping such an element shows its title in a
	 * bubble; tapping anywhere else or scrolling closes it. Only for elements
	 * that do nothing on a tap themselves: a button or link with a title keeps
	 * its action. With a mouse the browser's own tooltip is left alone.
	 */
	const MARGIN = 8;

	let tip = $state<{ text: string; left: number; top: number; above: boolean } | null>(null);
	let bubble = $state<HTMLElement | null>(null);

	function onClick(event: MouseEvent) {
		if (!matchMedia('(pointer: coarse)').matches) return;
		const target = event.target as HTMLElement | null;
		const el = target?.closest<HTMLElement>('[title]');
		if (!el || !el.title.trim() || el.closest('a, button, input, select, textarea, label, summary, [role="button"]')) {
			tip = null;
			return;
		}
		const box = el.getBoundingClientRect();
		const above = box.bottom > window.innerHeight * 0.7;
		tip = { text: el.title, left: box.left + box.width / 2, top: above ? box.top - MARGIN : box.bottom + MARGIN, above };
	}

	// Keep the bubble on screen once its width is known.
	$effect(() => {
		if (!tip || !bubble) return;
		const width = bubble.offsetWidth;
		const left = Math.min(Math.max(tip.left - width / 2, MARGIN), window.innerWidth - width - MARGIN);
		bubble.style.left = `${left}px`;
	});
</script>

<svelte:window onclick={onClick} onscroll={() => (tip = null)} onresize={() => (tip = null)} />

{#if tip}
	<div bind:this={bubble} class="tap-tip" class:above={tip.above} role="tooltip" style="top: {tip.top}px">{tip.text}</div>
{/if}

<style>
	.tap-tip {
		position: fixed;
		z-index: 70;
		max-width: min(20rem, calc(100vw - 16px));
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--panel-raised);
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
		color: var(--text);
		font-size: 0.85rem;
		line-height: 1.35;
		white-space: pre-line;
		overflow-wrap: anywhere;
	}

	.tap-tip.above {
		transform: translateY(-100%);
	}
</style>
