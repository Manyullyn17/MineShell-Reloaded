<script lang="ts">
	/**
	 * A form's submit button with a second action behind an arrow: "Install"
	 * plus "Install & start". Both submit the form; the hidden `start` field
	 * says which, and is set on the element directly (not through state) so
	 * it is in place when the click's submit reads the form - and stays set
	 * for a resubmit from the Java prompt.
	 */
	let {
		label,
		busyLabel = label,
		busy = false,
		disabled = false,
		altLabel,
		altNote = ''
	}: {
		label: string;
		busyLabel?: string;
		busy?: boolean;
		disabled?: boolean;
		altLabel: string;
		altNote?: string;
	} = $props();

	let open = $state(false);
	let startField = $state<HTMLInputElement | null>(null);
	let root = $state<HTMLElement | null>(null);
	/** Where the menu opens: above when there is no room below (the new-server form's bottom bar), right-aligned near the right edge. */
	let up = $state(false);
	let alignRight = $state(false);

	function toggle() {
		if (!open && root) {
			const box = root.getBoundingClientRect();
			up = window.innerHeight - box.bottom < 120 && box.top > window.innerHeight - box.bottom;
			alignRight = box.left + 280 > window.innerWidth;
		}
		open = !open;
	}

	function choose(start: boolean) {
		if (startField) startField.value = start ? 'on' : '';
		// Closed after the click: removing the menu item during it would take
		// the submitter out of the page, and the browser cancels the submit.
		setTimeout(() => (open = false));
	}

	function onWindowClick(event: MouseEvent) {
		if (open && root && !root.contains(event.target as Node)) open = false;
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={(e) => e.key === 'Escape' && (open = false)} />

<div class="split" bind:this={root}>
	<input type="hidden" name="start" value="" bind:this={startField} />
	<button class="button-primary main" type="submit" disabled={busy || disabled} onclick={() => choose(false)}>
		{busy ? busyLabel : label}
	</button>
	<button
		class="button-primary arrow"
		type="button"
		aria-label="More install options"
		aria-haspopup="menu"
		aria-expanded={open}
		disabled={busy || disabled}
		onclick={toggle}
	>
		<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" /></svg>
	</button>
	{#if open}
		<div class="menu" class:up class:align-right={alignRight} role="menu">
			<button type="submit" role="menuitem" onclick={() => choose(true)}>
				<span>{altLabel}</span>
				{#if altNote}<span class="note">{altNote}</span>{/if}
			</button>
		</div>
	{/if}
</div>

<style>
	.split {
		position: relative;
		display: inline-flex;
	}

	.main {
		border-top-right-radius: 0;
		border-bottom-right-radius: 0;
	}

	.arrow {
		padding-left: 0.55rem;
		padding-right: 0.55rem;
		border-top-left-radius: 0;
		border-bottom-left-radius: 0;
		border-left: 1px solid color-mix(in srgb, var(--accent-contrast) 30%, transparent);
	}

	.menu {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: 30;
		min-width: 100%;
		padding: var(--space-1);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--panel);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.25);
	}

	.menu.up {
		top: auto;
		bottom: calc(100% + 4px);
	}

	.menu.align-right {
		left: auto;
		right: 0;
	}

	.menu button {
		width: 100%;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		border-color: transparent;
		background: transparent;
		text-align: left;
	}

	.menu button:hover {
		background: var(--panel-raised);
	}

	.note {
		font-size: 0.78rem;
		font-weight: normal;
		color: var(--text-muted);
	}
</style>
