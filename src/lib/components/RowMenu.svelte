<script lang="ts">
	/**
	 * A ⋯ button opening a short menu of a row's rarer actions. The menu is
	 * fixed to the window, under the button and aligned to its right edge, so
	 * a table box's overflow does not cut it off, and follows it on scroll. Items
	 * are the caller's, given `close` to call when one is picked (a link or a
	 * button that opens something in the page; a submit closes it after the
	 * click, since removing the button during it would cancel the submit).
	 */
	import type { Snippet } from 'svelte';

	let { label = 'More actions', children }: { label?: string; children: Snippet<[() => void]> } = $props();

	let open = $state(false);
	let button = $state<HTMLButtonElement | null>(null);
	let place = $state({ top: 0, right: 0, up: false });

	/** Under the button, or above it when the row is near the bottom of the window. */
	function follow() {
		if (!button) return;
		const r = button.getBoundingClientRect();
		const up = window.innerHeight - r.bottom < 220 && r.top > 220;
		place = { top: up ? r.top - 6 : r.bottom + 6, right: Math.max(8, window.innerWidth - r.right), up };
	}
	function toggle() {
		if (!open) follow();
		open = !open;
	}
	const close = () => setTimeout(() => (open = false));
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && (open = false)} onscroll={() => open && follow()} onresize={() => open && follow()} />

<span class="row-menu">
	<button
		type="button"
		class="button-quiet more"
		bind:this={button}
		aria-label={label}
		title={label}
		aria-haspopup="menu"
		aria-expanded={open}
		onclick={toggle}>⋯</button
	>
	{#if open}
		<button type="button" class="scrim" aria-label="Close menu" onclick={() => (open = false)}></button>
		<div class="menu" class:up={place.up} role="menu" style:top="{place.top}px" style:right="{place.right}px">
			{@render children(close)}
		</div>
	{/if}
</span>

<style>
	.more {
		font-size: 1.1rem;
		line-height: 1;
	}
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 30;
		background: transparent;
		border: 0;
		padding: 0;
		cursor: default;
	}
	.menu {
		position: fixed;
		z-index: 31;
		min-width: 11rem;
		max-width: calc(100vw - 1rem);
		background: var(--panel-raised);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-lg);
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
		padding: 5px;
		text-align: left;
	}
	.menu.up {
		transform: translateY(-100%);
	}
	.menu :global([role='menuitem']) {
		display: flex;
		justify-content: flex-start;
		width: 100%;
		padding: 0.45rem 0.6rem;
		border: 0;
		border-radius: var(--radius);
		background: none;
		color: var(--text);
		font-size: 0.88rem;
		font-weight: 400;
		text-align: left;
		text-decoration: none;
		white-space: nowrap;
		cursor: pointer;
	}
	.menu :global([role='menuitem']:hover) {
		background: color-mix(in srgb, var(--text) 8%, transparent);
	}
	.menu :global([role='menuitem']:disabled) {
		color: var(--text-faint);
		cursor: default;
	}
	.menu :global([role='menuitem'].danger) {
		color: var(--error);
	}
</style>
