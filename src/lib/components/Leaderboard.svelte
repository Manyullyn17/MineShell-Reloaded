<script lang="ts">
	import PlayerFace from '#lib/components/PlayerFace.svelte';
	import { formatStat, HEADLINES, OVERFLOW_NOTE, overflowed, type StatUnit } from '#lib/shared/playerstats.js';

	/**
	 * Players ranked by one of their stats (lib/server/playerstats.ts,
	 * `leaderboard`): the headline numbers, or any general stat a player has.
	 */
	let {
		board,
		loading,
		player
	}: {
		board: { players: { uuid: string; values: Record<string, number> }[]; others: { id: string; name: string; unit: StatUnit }[] } | null;
		loading: boolean;
		/** A player's name and face, and their page (null when this account may not look). */
		player: (uuid: string) => { name: string | null; skin: string | null; href: string | null };
	} = $props();

	const TOP = 10;
	let statId = $state(HEADLINES[0].id);
	let showAll = $state(false);
	$effect(() => {
		void statId;
		showAll = false;
	});

	const stat = $derived(HEADLINES.find((h) => h.id === statId) ?? board?.others.find((o) => o.id === statId) ?? HEADLINES[0]);
	const ranked = $derived(
		(board?.players ?? [])
			.map((p) => ({ uuid: p.uuid, value: p.values[statId] ?? 0 }))
			.filter((p) => p.value > 0)
			.sort((a, b) => b.value - a.value)
	);
	const shown = $derived(showAll ? ranked : ranked.slice(0, TOP));
	/** Players whose counter for this wrapped: no value to rank them by. */
	const lost = $derived((board?.players ?? []).filter((p) => overflowed(p.values[statId] ?? 0)));
</script>

<div class="board">
	<label class="pick">
		<span class="small muted">Rank by</span>
		<select bind:value={statId} disabled={!board}>
			<optgroup label="Highlights">
				{#each HEADLINES as h (h.id)}<option value={h.id}>{h.label}</option>{/each}
			</optgroup>
			{#if board?.others.length}
				<optgroup label="All general stats">
					{#each board.others as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
				</optgroup>
			{/if}
		</select>
	</label>

	{#if !board}
		<p class="faint small">{loading ? 'Reading the stats files…' : 'The stats files could not be read.'}</p>
	{:else if ranked.length === 0}
		<p class="faint small">
			{board.players.length ? 'Nobody has any of this yet.' : 'No stats in this world yet. The game writes them when players leave and when the world saves.'}
		</p>
	{:else}
		<ol class="ranks">
			{#each shown as row, i (row.uuid)}
				{@const p = player(row.uuid)}
				<li>
					<span class="rank mono faint">{i + 1}</span>
					<PlayerFace id={row.uuid} skin={p.skin} size={20} />
					{#if p.href}<a href={p.href}>{p.name ?? row.uuid.slice(0, 8)}</a>{:else}<span>{p.name ?? row.uuid.slice(0, 8)}</span>{/if}
					<span class="value mono">{formatStat(row.value, stat.unit)}</span>
				</li>
			{/each}
		</ol>
		{#if ranked.length > shown.length}
			<button type="button" class="button-quiet" onclick={() => (showAll = true)}>Show all {ranked.length}</button>
		{/if}
	{/if}
	{#if board && lost.length}
		<p class="faint small">
			Not ranked, their counter <span class="overflow" title={OVERFLOW_NOTE}>overflowed</span>: {lost.map((p) => player(p.uuid).name ?? p.uuid.slice(0, 8)).join(', ')}
		</p>
	{/if}
</div>

<style>
	.board {
		display: grid;
		gap: 0.75rem;
	}
	.pick {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.pick select {
		max-width: 20rem;
	}
	.ranks {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.15rem;
		max-width: 32rem;
	}
	.ranks li {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.3rem 0.4rem;
		border-radius: var(--radius);
	}
	.ranks li:nth-child(odd) {
		background: color-mix(in srgb, var(--text-muted) 7%, transparent);
	}
	.rank {
		width: 1.75rem;
		text-align: right;
	}
	.overflow {
		color: var(--warning);
		cursor: help;
		text-decoration: underline dotted;
	}
	.value {
		margin-left: auto;
		white-space: nowrap;
	}
</style>
