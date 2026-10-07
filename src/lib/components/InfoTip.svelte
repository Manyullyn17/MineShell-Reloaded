<script lang="ts">
	/**
	 * A small "i" that shows `text` on hover, keyboard focus or a tap. The text
	 * is placed when it opens and kept inside the screen: it used to hang off
	 * the button's right edge, which ran it off the left side of a phone when
	 * the "i" sat near that edge.
	 */
	let { text, label = 'More information' }: { text: string; label?: string } = $props();
	const id = `tip-${Math.random().toString(36).slice(2, 9)}`;
	const MARGIN = 8;

	let button = $state<HTMLButtonElement | null>(null);
	let tip = $state<HTMLElement | null>(null);
	let open = $state(false);
	/** Opened by a tap or click: stays until the next tap elsewhere, rather than following hover. */
	let pinned = $state(false);

	function place() {
		if (!button || !tip) return;
		const b = button.getBoundingClientRect();
		const width = tip.offsetWidth;
		const height = tip.offsetHeight;
		const left = Math.min(Math.max(b.right - width, MARGIN), window.innerWidth - width - MARGIN);
		const below = b.bottom + 6 + height <= window.innerHeight - MARGIN;
		tip.style.left = `${left}px`;
		tip.style.top = `${below ? b.bottom + 6 : b.top - 6 - height}px`;
	}

	$effect(() => {
		if (open) place();
	});

	function onWindowPointer(event: PointerEvent) {
		if (pinned && !button?.contains(event.target as Node)) {
			pinned = false;
			open = false;
		}
	}
</script>

<svelte:window onpointerdown={onWindowPointer} onscroll={() => open && place()} onresize={() => open && place()} />

<span class="info-tip">
	<button
		bind:this={button}
		type="button"
		class="hit-area"
		aria-label={label}
		aria-describedby={id}
		aria-expanded={open}
		onmouseenter={() => (open = true)}
		onmouseleave={() => !pinned && (open = false)}
		onfocus={() => (open = true)}
		onblur={() => !pinned && (open = false)}
		onclick={() => {
			pinned = !pinned;
			open = pinned;
		}}>i</button
	>
	<span bind:this={tip} role="tooltip" {id} class:open>{text}</span>
</span>

<style>
	.info-tip {
		display: inline-flex;
		align-items: center;
	}

	button {
		width: 1.15rem;
		height: 1.15rem;
		padding: 0;
		border-radius: 50%;
		border: 1px solid var(--line-strong);
		background: transparent;
		color: var(--text-muted);
		font-size: 0.72rem;
		font-weight: 600;
		line-height: 1;
		cursor: help;
	}

	[role='tooltip'] {
		position: fixed;
		top: 0;
		left: 0;
		z-index: 60;
		width: max-content;
		max-width: min(20rem, calc(100vw - 16px));
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--panel);
		color: var(--text);
		font-size: 0.82rem;
		font-weight: normal;
		line-height: 1.4;
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.25);
		visibility: hidden;
		opacity: 0;
		transition: opacity 0.1s;
		pointer-events: none;
	}

	[role='tooltip'].open {
		visibility: visible;
		opacity: 1;
	}
</style>
