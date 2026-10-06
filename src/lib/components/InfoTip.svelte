<script lang="ts">
	/** A small "i" that shows `text` on hover or keyboard focus. */
	let { text, label = 'More information' }: { text: string; label?: string } = $props();
	const id = `tip-${Math.random().toString(36).slice(2, 9)}`;
</script>

<span class="info-tip">
	<button type="button" class="hit-area" aria-label={label} aria-describedby={id}>i</button>
	<span role="tooltip" {id}>{text}</span>
</span>

<style>
	.info-tip {
		position: relative;
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
		font-style: italic;
		font-weight: 600;
		line-height: 1;
		cursor: help;
	}

	[role='tooltip'] {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 30;
		width: max-content;
		max-width: 20rem;
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

	.info-tip:hover [role='tooltip'],
	button:focus-visible + [role='tooltip'] {
		visibility: visible;
		opacity: 1;
	}
</style>
