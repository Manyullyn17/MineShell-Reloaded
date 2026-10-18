<script lang="ts">
	import ItemIcon from '#lib/components/ItemIcon.svelte';
	import type { iconLoader } from '#lib/shared/itemicon.svelte.js';
	import { formatRelative } from '#lib/shared/format.js';
	import {
		CATEGORY_LABELS,
		formatStat,
		HEADLINES,
		headlineValue,
		STAT_CATEGORIES,
		statUnit,
		type StatCategory,
		type StatTable
	} from '#lib/shared/playerstats.js';

	/**
	 * A player's statistics (lib/server/playerstats.ts): the headline numbers,
	 * then one category at a time as a list, biggest first.
	 */
	let {
		stats,
		loading,
		icons
	}: {
		stats: { stats: StatTable; modifiedAt: number; names: Record<StatCategory, Record<string, string>> } | null;
		loading: boolean;
		icons: ReturnType<typeof iconLoader>;
	} = $props();

	/** Rows shown before "Show all": 1.12 packs pick up over a thousand kinds of things. */
	const FIRST_ROWS = 200;

	let category = $state<StatCategory>('custom');
	let query = $state('');
	let showAll = $state(false);
	$effect(() => {
		void category;
		void query;
		showAll = false;
	});

	const withItems = (c: StatCategory) => c !== 'custom' && c !== 'killed' && c !== 'killed_by';
	const categories = $derived(stats ? STAT_CATEGORIES.filter((c) => Object.keys(stats.stats[c]).length) : []);
	const rows = $derived.by(() => {
		if (!stats) return [];
		const q = query.trim().toLowerCase();
		const names = stats.names[category];
		return Object.entries(stats.stats[category])
			.map(([id, value]) => ({ id, value, name: names[id] ?? id }))
			.filter((r) => !q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
			.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
	});
	const shown = $derived(showAll ? rows : rows.slice(0, FIRST_ROWS));
	const total = (c: StatCategory) => (stats ? Object.values(stats.stats[c]).reduce((a, b) => a + b, 0) : 0);
	const unitOf = (id: string) => (category === 'custom' ? statUnit(id) : 'count');
</script>

{#if !stats}
	<section class="panel">
		<h2>Stats</h2>
		<p class="muted">
			{loading
				? 'Reading the stats file…'
				: "No stats for this player in this world yet. The game writes them when the player leaves and when the world saves."}
		</p>
	</section>
{:else}
	<dl class="strip">
		{#each HEADLINES as h (h.id)}
			<div>
				<dt>{h.label}</dt>
				<dd class="mono">{formatStat(headlineValue(stats.stats, h.id), h.unit)}</dd>
			</div>
		{/each}
	</dl>

	<section class="panel">
		<div class="head">
			<h2>All stats</h2>
			<span class="small faint">saved {formatRelative(stats.modifiedAt)}</span>
		</div>
		<div class="controls">
			<nav class="chips" aria-label="Stat categories">
				{#each categories as c (c)}
					<button type="button" aria-pressed={category === c} onclick={() => (category = c)}>
						{CATEGORY_LABELS[c]}{#if c !== 'custom'}<span class="faint"> · {total(c).toLocaleString('en-US')}</span>{/if}
					</button>
				{/each}
			</nav>
			<input type="search" placeholder="Search" aria-label="Search stats" bind:value={query} />
		</div>
		{#if rows.length === 0}
			<p class="muted">{query.trim() ? 'Nothing matches that search.' : 'Nothing counted here yet.'}</p>
		{:else}
			<div class="table-box">
				<table>
					<tbody>
						{#each shown as row (row.id)}
							<tr>
								<td>
									<div class="name">
										{#if withItems(category) && !row.id.startsWith('#')}
											<span class="icon"><ItemIcon loader={icons} id={row.id} size={24} /></span>
										{/if}
										<span>{row.name}</span>
										<span class="faint small mono id">{row.id}</span>
									</div>
								</td>
								<td class="value mono">{formatStat(row.value, unitOf(row.id))}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if rows.length > shown.length}
				<button type="button" class="button-quiet more" onclick={() => (showAll = true)}>Show all {rows.length.toLocaleString('en-US')}</button>
			{/if}
		{/if}
	</section>
{/if}

<style>
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.controls {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		margin: 0.75rem 0;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.chips button {
		font-size: 0.85rem;
		padding: 0.25rem 0.65rem;
	}
	.chips button[aria-pressed='true'] {
		border-color: var(--accent);
		color: var(--accent-hover);
	}
	.controls input {
		max-width: 16rem;
	}
	table {
		width: 100%;
	}
	.name {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.icon {
		display: inline-flex;
		width: 24px;
		height: 24px;
		flex: none;
	}
	.id {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.value {
		text-align: right;
		white-space: nowrap;
	}
	.more {
		margin-top: 0.5rem;
	}
	@media (max-width: 60rem) {
		.id {
			display: none;
		}
		.controls input {
			max-width: none;
			width: 100%;
		}
	}
</style>
