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
		title,
		description,
		dirty = false,
		aside,
		children
	}: {
		tab: string;
		title: string;
		description?: Snippet | string;
		/** Has unsaved changes; marks the heading. */
		dirty?: boolean;
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

<section class="settings-section" hidden={!shown} bind:this={node}>
	<div class="head">
		<div>
			{#if view.query}<p class="where">{view.tabLabel(tab)}</p>{/if}
			<h2>
				{#if dirty}<span class="changed" title="Unsaved changes"></span>{/if}{title}
			</h2>
			{#if typeof description === 'string'}
				{#if description}<p class="desc">{description}</p>{/if}
			{:else if description}
				<p class="desc">{@render description()}</p>
			{/if}
		</div>
		{#if aside}<div class="aside">{@render aside()}</div>{/if}
	</div>
	{@render children?.()}
</section>

<style>
	.settings-section {
		padding-top: 1.75rem;
	}

	.settings-section[hidden] {
		display: none;
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
</style>
