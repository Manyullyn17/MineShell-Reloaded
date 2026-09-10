<script lang="ts">
	/**
	 * Generic filter sidebar: give it a list of groups (each with its own
	 * options) and it renders a collapsible checkbox section per group,
	 * reporting the selected values back via the bindable `selected` prop.
	 *
	 * Deliberately dumb about what the groups mean - a "loader" group and a
	 * "category" group are rendered identically. The caller decides what
	 * groups exist and what to do with the selections.
	 */
	import { fitToViewport } from '$lib/shared/fitToViewport';

	type FilterGroup = { id: string; label: string; options: { value: string; label: string }[] };

	let {
		groups = [],
		selected = $bindable({}),
		loading = false,
		limitNote = '',
		maxHeightMarginPx = 24
	}: {
		groups?: FilterGroup[];
		selected?: Record<string, string[]>;
		loading?: boolean;
		/** Shown once at the top - e.g. "only the first pick per group applies here". */
		limitNote?: string;
		/** Room to leave below the sidebar before its own scrollbar kicks in. */
		maxHeightMarginPx?: number;
	} = $props();

	// Every group starts open except ones with a lot of options, which start
	// collapsed so the sidebar isn't a wall of checkboxes on first render.
	let openGroups = $state<Record<string, boolean>>({});
	$effect(() => {
		const next: Record<string, boolean> = {};
		for (const group of groups) {
			if (!(group.id in openGroups)) next[group.id] = group.options.length <= 8;
		}
		if (Object.keys(next).length) openGroups = { ...openGroups, ...next };
	});

	function isChecked(groupId: string, value: string): boolean {
		return selected[groupId]?.includes(value) ?? false;
	}

	function toggle(groupId: string, value: string) {
		const current = selected[groupId] ?? [];
		selected = {
			...selected,
			[groupId]: current.includes(value)
				? current.filter((v) => v !== value)
				: [...current, value]
		};
	}

	const activeCount = $derived(
		Object.values(selected).reduce((sum, values) => sum + values.length, 0)
	);

	function clearAll() {
		selected = {};
	}
</script>

<aside class="sidebar" use:fitToViewport={maxHeightMarginPx}>
	<div class="head">
		<h3>Filters</h3>
		{#if activeCount > 0}
			<button type="button" class="button-quiet clear" onclick={clearAll}>
				Clear ({activeCount})
			</button>
		{/if}
	</div>

	{#if limitNote}
		<p class="hint limit-note">{limitNote}</p>
	{/if}

	{#if loading}
		<p class="muted small">Loading filters.</p>
	{:else if groups.length === 0}
		<p class="muted small">No filters are available for this source.</p>
	{:else}
		{#each groups as group (group.id)}
			<details bind:open={openGroups[group.id]}>
				<summary>
					{group.label}
					{#if selected[group.id]?.length}
						<span class="count">{selected[group.id].length}</span>
					{/if}
				</summary>
				<div class="options">
					{#each group.options as option (option.value)}
						<label>
							<input
								type="checkbox"
								checked={isChecked(group.id, option.value)}
								onchange={() => toggle(group.id, option.value)}
							/>
							{option.label}
						</label>
					{/each}
				</div>
			</details>
		{/each}
	{/if}
</aside>

<style>
	.sidebar {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
		overflow-y: auto;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.head h3 {
		margin: 0;
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--text-faint);
	}

	.clear {
		font-size: 0.78rem;
		padding: 0.15rem 0.5rem;
	}

	.limit-note {
		margin: 0 0 var(--space-2);
	}

	details {
		border-bottom: 1px solid var(--line);
		padding-bottom: var(--space-2);
	}

	summary {
		cursor: pointer;
		font-size: 0.88rem;
		padding: var(--space-1) 0;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		list-style: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	summary::before {
		content: '▸';
		font-size: 0.7rem;
		color: var(--text-faint);
		transition: transform 0.15s ease;
	}

	details[open] summary::before {
		transform: rotate(90deg);
	}

	.count {
		font-family: var(--font-mono);
		font-size: 0.72rem;
		color: var(--accent);
	}

	.options {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: var(--space-1) 0 var(--space-2) var(--space-4);
		max-height: 14rem;
		overflow-y: auto;
	}

	.options label {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: 0.85rem;
		font-weight: 400;
		color: var(--text-muted);
		cursor: pointer;
		margin: 0;
	}

	.options input {
		width: auto;
		margin: 0;
	}
</style>
