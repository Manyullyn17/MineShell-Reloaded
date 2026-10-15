<script lang="ts">
	import { CREDITS, MINECRAFT_DISCLAIMER } from '#lib/shared/credits.js';

	const REPO = 'https://github.com/Manyullyn17/MineShell-Reloaded';
</script>

<svelte:head><title>About - MineShell</title></svelte:head>

<header class="page-head">
	<h1>About MineShell</h1>
	<p class="muted">
		Version {__MINESHELL_VERSION__} · <a href={REPO} target="_blank" rel="noreferrer">Source on GitHub</a> ·
		<a href="{REPO}/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT license</a>
	</p>
	<p class="muted small">{MINECRAFT_DISCLAIMER}</p>
</header>

<p class="lead">MineShell stands on a lot of other people's work. Thank you to everyone behind these.</p>

{#each CREDITS as group (group.title)}
	<section class="panel">
		<div class="panel-head">
			<div>
				<h2>{group.title}</h2>
				<p>{group.intro}</p>
			</div>
		</div>
		<ul class="credits">
			{#each group.items as item (item.name)}
				<li>
					<a href={item.url} target="_blank" rel="noreferrer">{item.name}</a>
					<span class="use">{item.use}</span>
					{#if item.license}<span class="tag">{item.license}</span>{/if}
				</li>
			{/each}
		</ul>
	</section>
{/each}

<style>
	.page-head {
		margin-bottom: var(--space-5);
	}

	.page-head p {
		margin: var(--space-1) 0 0;
	}

	.lead {
		margin: 0 0 var(--space-4);
	}

	.credits {
		list-style: none;
		margin: var(--space-3) 0 0;
		padding: 0;
	}

	.credits li {
		display: grid;
		grid-template-columns: minmax(10rem, 16rem) 1fr auto;
		align-items: baseline;
		gap: var(--space-3);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--line);
	}

	.credits li:last-child {
		border-bottom: none;
	}

	.use {
		color: var(--text-muted);
	}

	@media (max-width: 60rem) {
		.credits li {
			grid-template-columns: 1fr auto;
			gap: var(--space-1) var(--space-3);
		}

		.use {
			grid-column: 1 / -1;
			grid-row: 2;
		}
	}
</style>
