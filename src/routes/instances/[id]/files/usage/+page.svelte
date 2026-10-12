<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import { refreshAll } from '$app/navigation';
	import Flash from '#lib/components/Flash.svelte';
	import { formatBytes, formatRelative } from '#lib/shared/format.js';

	let { data, form } = $props();

	const base = $derived(`/instances/${encodeURIComponent(data.instance.id)}`);
	const filesHref = (rel: string) => `${base}/files?path=${encodeURIComponent(rel)}`;
	const share = (bytes: number, total: number) => (total > 0 ? Math.max(0.5, (bytes / total) * 100) : 0);
	const percent = (bytes: number, total: number) => {
		const p = total > 0 ? (bytes / total) * 100 : 0;
		return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
	};
	let measuring = $state(false);
</script>

<Flash {form} />

<section class="panel">
	<div class="panel-head">
		<div>
			<h2>Disk usage</h2>
			<p>Where this server's space goes. Groups add up to the total; each row links into Files (the map MineShell renders, kept outside the server folder, to the Map tab).</p>
		</div>
		<div class="row">
			<a class="button button-quiet" href="{base}/files">Back to files</a>
			<button
				onclick={async () => {
					measuring = true;
					await refreshAll();
					measuring = false;
				}}
				disabled={measuring}>{measuring ? 'Measuring' : 'Measure again'}</button
			>
		</div>
	</div>

	{#await data.breakdown}
		<p class="muted">Measuring every file of this server; a big world takes a moment.</p>
	{:then usage}
		<p class="total">
			<strong class="mono">{formatBytes(usage.total)}</strong>
			<span class="faint small">measured {formatRelative(usage.measuredAt)}</span>
		</p>

		{#if usage.suggestions.length}
			<h3>Could be cleaned up</h3>
			<ul class="suggestions">
				{#each usage.suggestions as suggestion (suggestion.text)}
					<li>
						<span class="mono size">{formatBytes(suggestion.bytes)}</span>
						<span class="text">{suggestion.text}</span>
						{#if suggestion.action === 'deleteOldLogs'}
							<form method="POST" action="?/deleteOldLogs" use:enhance>
								<button class="button-danger">Delete them</button>
							</form>
						{:else if suggestion.href?.tab === 'world'}
							<a class="button button-quiet" href="{base}/world">World tab</a>
						{:else if suggestion.href}
							<a class="button button-quiet" href={filesHref(suggestion.href.path ?? '')}>Open in Files</a>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		<table class="usage">
			<thead>
				<tr>
					<th>What</th>
					<th class="num">Size</th>
					<th class="num">Share</th>
					<th class="bar-col"><span class="visually-hidden">Share of the total</span></th>
				</tr>
			</thead>
			{#each usage.groups as group (group.id)}
				<tbody>
					<tr class="group">
						<th scope="rowgroup">{group.label}</th>
						<td class="num mono" data-label="Size">{formatBytes(group.bytes)}</td>
						<td class="num mono faint" data-label="Share">{percent(group.bytes, usage.total)}</td>
						<td class="bar-col" aria-hidden="true">
							<span class="bar" style:width="{share(group.bytes, usage.total)}%"></span>
						</td>
					</tr>
					{#each group.items as item (item.path)}
						<tr>
							<td class="item">
								<a href={item.outside ? `/instances/${encodeURIComponent(data.instance.id)}/map` : filesHref(item.path)}>{item.label}</a>
								{#if item.note === 'pinned'}<span class="tag accent">pinned</span>{:else if item.note}<div class="faint small">{item.note}</div>{/if}
							</td>
							<td class="num mono" data-label="Size">{formatBytes(item.bytes)}</td>
							<td class="num mono faint" data-label="Share">{percent(item.bytes, usage.total)}</td>
							<td class="bar-col" aria-hidden="true">
								<span class="bar thin" style:width="{share(item.bytes, usage.total)}%"></span>
							</td>
						</tr>
					{/each}
				</tbody>
			{/each}
		</table>
	{:catch}
		<div class="notice error"><p>Could not measure this server's folder.</p></div>
	{/await}
</section>

<style>
	.total {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		font-size: 1.3rem;
	}

	@media (max-width: 40rem) {
		:global(.panel-head) {
			align-items: stretch;
			flex-direction: column;
		}

		:global(.panel-head > div:first-child) {
			min-width: 0;
		}

		:global(.panel-head > div:first-child p) {
			max-width: none;
			overflow-wrap: anywhere;
		}

		:global(.panel-head > .row) {
			flex-wrap: wrap;
		}

		.suggestions li {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: center;
			gap: var(--space-2) var(--space-3);
			padding: var(--space-3) 0;
		}

		.suggestions .text {
			grid-column: 1 / -1;
			grid-row: 1;
		}

		.suggestions .size {
			grid-column: 1;
			grid-row: 2;
		}

		.suggestions li > form,
		.suggestions li > a {
			grid-column: 2;
			grid-row: 2;
		}

		:global(.content table.usage) {
			display: block;
			width: 100%;
			overflow: visible;
			border-collapse: separate;
			border-spacing: 0;
		}

		.usage thead {
			display: none;
		}

		.usage tbody {
			display: block;
			margin: 0 0 var(--space-3);
			padding: var(--space-3);
			background: var(--panel);
			border: 1px solid var(--line);
			border-radius: var(--radius-lg);
		}

		.usage tr {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			gap: var(--space-2) var(--space-3);
			padding: var(--space-2) 0;
			border-bottom: 1px solid var(--line);
		}

		.usage tr:last-child {
			border-bottom: 0;
		}

		.usage .group th {
			grid-column: 1 / -1;
			padding: 0 0 var(--space-2);
			border: 0;
		}

		.usage .group td {
			border: 0;
		}

		.usage td,
		.usage th {
			min-width: 0;
			padding: 0;
			text-align: left;
		}

		.usage td.item {
			grid-column: 1 / -1;
			padding-left: 0;
			overflow-wrap: anywhere;
		}

		.usage td.num {
			white-space: normal;
			font-size: 0.9rem;
		}

		.usage td.num::before {
			content: attr(data-label);
			display: block;
			margin-bottom: 0.1rem;
			color: var(--text-faint);
			font-size: 0.72rem;
			font-family: inherit;
			font-weight: 400;
		}

		.usage .bar-col {
			grid-column: 1 / -1;
			width: auto;
			padding: 0;
			border: 0;
		}
	}

	h3 {
		margin: var(--space-4) 0 var(--space-2);
	}

	.suggestions {
		list-style: none;
		margin: 0 0 var(--space-5);
		padding: 0;
	}

	.suggestions li {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--line);
		font-size: 0.9rem;
	}

	.suggestions .size {
		flex: 0 0 5.5rem;
	}

	.suggestions .text {
		flex: 1 1 auto;
		min-width: 0;
	}

	.usage .group th,
	.usage .group td {
		padding-top: var(--space-4);
		font-weight: 600;
		color: var(--text);
		border-bottom: 1px solid var(--line-strong);
	}

	.usage .group th {
		text-align: left;
		font-size: 0.9rem;
	}

	.item {
		padding-left: var(--space-5);
		overflow-wrap: anywhere;
	}

	.num {
		text-align: right;
		white-space: nowrap;
	}

	.bar-col {
		width: 30%;
	}

	/* One measure, one hue: a bar per row, its length the share of the total. */
	.bar {
		display: block;
		height: 8px;
		background: var(--accent);
		border-radius: 0 4px 4px 0;
	}

	.bar.thin {
		height: 4px;
		background: color-mix(in srgb, var(--accent) 60%, transparent);
	}

	li .button,
	li button {
		font-size: 0.82rem;
		padding: 0.2rem 0.5rem;
	}
</style>
