<script lang="ts">
	import { page } from '$app/stores';
	import StatusPill from '$lib/components/StatusPill.svelte';

	let { data, children } = $props();

	const tabs = [
		{ slug: '', label: 'Overview' },
		{ slug: 'console', label: 'Console' },
		{ slug: 'logs', label: 'Logs' },
		{ slug: 'properties', label: 'Server settings' },
		{ slug: 'mods', label: 'Mods' },
		{ slug: 'world', label: 'World' },
		{ slug: 'players', label: 'Players' },
		{ slug: 'files', label: 'Files' },
		{ slug: 'settings', label: 'Instance settings' }
	];

	const base = $derived(`/instances/${data.instance.id}`);
	const current = $derived($page.url.pathname.replace(base, '').replace(/^\//, ''));
</script>

<svelte:head><title>{data.instance.name} - MineShell</title></svelte:head>

<div class="sticky-head">
<header class="instance-head">
	<div class="identity">
		<h1>{data.instance.name}</h1>
		<StatusPill active={data.state.active} sub={data.state.sub} />
	</div>
	<div class="tags">
		<span class="tag">{data.instance.minecraftVersion}</span>
		<span class="tag accent">
			{data.instance.modloaderLabel}{data.instance.modloaderVersion
				? ` ${data.instance.modloaderVersion}`
				: ''}
		</span>
		<span class="tag">:{data.instance.serverPort}</span>
		{#if data.instance.packName}
			<span class="tag">{data.instance.packName}</span>
		{/if}
	</div>
</header>

<nav class="tabs" aria-label="Server sections">
	{#each tabs as tab (tab.slug)}
		<a href={tab.slug ? `${base}/${tab.slug}` : base} aria-current={current === tab.slug ? 'page' : undefined}>
			{tab.label}
		</a>
	{/each}
</nav>
</div>

{@render children()}

<style>
	/* Header and tabs stay visible while the content below scrolls. Both live in
	   one sticky wrapper so they never separate mid-scroll, with a background
	   so page content does not show through. */
	.sticky-head {
		position: sticky;
		top: 0;
		z-index: 20;
		background: var(--bg);
		margin: calc(var(--space-4) * -1) calc(var(--space-4) * -1) var(--space-5);
		padding: var(--space-4) var(--space-4) 0;
	}

	.instance-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: var(--space-3);
	}

	.identity {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.tags {
		display: flex;
		gap: var(--space-1);
		flex-wrap: wrap;
	}

	.tabs {
		display: flex;
		gap: var(--space-1);
		border-bottom: 1px solid var(--line);
		overflow-x: auto;
	}

	.tabs a {
		padding: var(--space-2) var(--space-3);
		color: var(--text-muted);
		text-decoration: none;
		border-bottom: 2px solid transparent;
		white-space: nowrap;
		font-size: 0.9rem;
	}

	.tabs a:hover {
		color: var(--text);
	}

	.tabs a[aria-current='page'] {
		color: var(--text);
		border-bottom-color: var(--accent);
	}
</style>
