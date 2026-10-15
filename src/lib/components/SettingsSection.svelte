<script lang="ts" module>
	import { getContext, setContext } from 'svelte';

	/** What the settings page shows: one tab, or every section matching a search. */
	export type SettingsView = { readonly tab: string; readonly query: string; tabLabel(id: string): string };
	const KEY = Symbol('settings-view');

	export function provideSettingsView(view: SettingsView) {
		setContext(KEY, view);
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * One section of a server's Settings. Every section stays mounted, hidden
	 * when its tab is not open, so unsaved edits survive switching tabs and a
	 * search can look through all of them. The search matches the section's
	 * own text: title, description and every label and hint in it.
	 */
	let {
		tab,
		id,
		title,
		description,
		dirty = false,
		editable = true,
		aside,
		children
	}: {
		tab: string;
		/** For links to the section (`#id`). */
		id?: string;
		title: string;
		description?: Snippet | string;
		/** Has unsaved changes; marks the heading. */
		dirty?: boolean;
		/** False: shown, but every field and button in it disabled (the account may look, not change). */
		editable?: boolean;
		/** Actions beside the heading. */
		aside?: Snippet;
		children?: Snippet;
	} = $props();

	const view = getContext<SettingsView>(KEY);
	let node = $state<HTMLElement | null>(null);
	let text = $state('');
	$effect(() => {
		// Read once the content is in place; labels do not change while searching.
		if (node && view.query) text = node.textContent?.toLowerCase() ?? '';
	});
	const shown = $derived(view.query ? text.includes(view.query.toLowerCase()) : view.tab === tab);
</script>

<section class="settings-section" {id} hidden={!shown} bind:this={node}>
	<div class="head">
		<div>
			{#if view.query}<p class="where">{view.tabLabel(tab)}</p>{/if}
			<h2>
				{#if dirty}<span class="changed" title="Unsaved changes"></span>{/if}{title}
				{#if !editable}<span class="tag view-only">view only</span>{/if}
			</h2>
			{#if typeof description === 'string'}
				{#if description}<p class="desc">{description}</p>{/if}
			{:else if description}
				<p class="desc">{@render description()}</p>
			{/if}
		</div>
		{#if aside && editable}<div class="aside">{@render aside()}</div>{/if}
	</div>
	{#if editable}
		{@render children?.()}
	{:else}
		<!-- A disabled fieldset disables everything in it, forms nested inside included. -->
		<fieldset class="view-only-body" disabled>{@render children?.()}</fieldset>
	{/if}
</section>

<style>
	.settings-section {
		padding-top: 1.75rem;
	}

	.settings-section[hidden] {
		display: none;
	}

	.view-only-body {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}

	.view-only {
		margin-left: var(--space-2);
		vertical-align: middle;
		font-weight: 400;
	}

	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 1.05rem;
	}

	.changed {
		width: 6px;
		height: 6px;
		border-radius: 1px;
		background: var(--warning);
	}

	.where {
		margin: 0 0 0.15rem;
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.desc {
		margin: 0.2rem 0 0;
		font-size: 0.88rem;
		color: var(--text-muted);
	}

	.aside {
		display: flex;
		gap: var(--space-2);
	}

	/* ---- what sections hold, here so the page and its section components share it */

	/* Rows: label and help on the left, the control on the right. The shared
	   field components (PropertyInput, RestartFields, ConsoleFields,
	   SnapshotPolicyFields) keep their markup; this lays it out. */

	:global(.settings-section .rows) {
		display: flex;
		flex-direction: column;
		margin-top: 0.4rem;
	}

	:global(.settings-section .rows .grid-2),
	:global(.settings-section .rows .policy) {
		display: contents;
	}

	:global(.settings-section .rows fieldset) {
		border: 0;
		padding: 0;
		margin: 0;
		display: contents;
	}

	:global(.settings-section .rows legend) {
		display: block;
		padding: 1.2rem 0 0.2rem;
		font-size: 0.8rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	:global(.settings-section .rows .field) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(9rem, 20rem);
		column-gap: 2rem;
		row-gap: 0.2rem;
		align-items: center;
		margin: 0;
		padding: 0.85rem 0;
		border-bottom: 1px solid var(--panel-raised);
	}

	:global(.settings-section .rows .field > label),
	:global(.settings-section .rows .field > .label),
	:global(.settings-section .rows .field .check > label) {
		grid-column: 1;
		grid-row: 1;
		margin: 0;
		font-size: 0.95rem;
		font-weight: 500;
		color: var(--text);
	}

	:global(.settings-section .rows .field > input),
	:global(.settings-section .rows .field > select),
	:global(.settings-section .rows .field > .control),
	:global(.settings-section .rows .field .check > input) {
		grid-column: 2;
		grid-row: 1 / span 2;
		justify-self: end;
	}

	:global(.settings-section .rows .field > input:not([type='checkbox'])),
	:global(.settings-section .rows .field > select) {
		width: 100%;
	}

	:global(.settings-section .rows .field > input[type='number']) {
		max-width: 8rem;
		text-align: right;
	}

	:global(.settings-section .rows .field > .hint),
	:global(.settings-section .rows .field > p) {
		grid-column: 1;
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	:global(.settings-section .rows .field .check) {
		display: contents;
	}

	/* Wide controls (text areas) go under the label instead. */
	:global(.settings-section .rows .field.wide),
	:global(.settings-section .rows .field:has(> textarea)) {
		grid-template-columns: minmax(0, 1fr);
	}

	:global(.settings-section .rows .field.wide > input),
	:global(.settings-section .rows .field > textarea) {
		grid-column: 1;
		grid-row: auto;
		justify-self: stretch;
		width: 100%;
	}

	/* Checkboxes in rows are switches (ones marked .switch already are: app.css). */
	:global(.settings-section .rows input[type='checkbox']:not(.switch)) {
		appearance: none;
		width: 40px;
		height: 22px;
		margin: 0;
		border-radius: 11px;
		cursor: pointer;
		background: var(--line-strong) radial-gradient(circle at 11px 11px, var(--text) 7px, transparent 7.5px) no-repeat;
		background-position: 0 0;
		transition:
			background-position 0.12s,
			background-color 0.12s;
	}

	:global(.settings-section .rows input[type='checkbox']:not(.switch):checked) {
		background-color: var(--accent);
		background-position: 18px 0;
	}

	:global(.settings-section .rows .field.changed > label::before) {
		content: '';
		display: inline-block;
		width: 6px;
		height: 6px;
		margin-right: 0.45rem;
		vertical-align: middle;
		border-radius: 1px;
		background: var(--warning);
	}

	:global(.settings-section .rows > p.faint),
	:global(.settings-section .rows .policy > fieldset > p.faint) {
		margin: var(--space-2) 0 0;
	}

	@media (max-width: 60rem) {
		:global(.settings-section .rows .field) {
			grid-template-columns: minmax(0, 1fr);
		}

		:global(.settings-section .rows .field > input),
		:global(.settings-section .rows .field > select),
		:global(.settings-section .rows .field > .control),
		:global(.settings-section .rows .field .check > input) {
			grid-column: 1;
			grid-row: auto;
			justify-self: start;
		}
	}

	/* Blocks: things with their own buttons. */
	:global(.settings-section .block) {
		margin-top: 0.9rem;
		padding: var(--space-4);
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
	}

	:global(.settings-section .inline-row) {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	:global(.settings-section .inline-row select),
	:global(.settings-section .inline-row input) {
		width: auto;
		min-width: 16rem;
	}

	:global(.settings-section textarea.mono),
	:global(.settings-section input.mono) {
		font-family: var(--font-mono);
		font-size: 0.82rem;
	}
</style>
