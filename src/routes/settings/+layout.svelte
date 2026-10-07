<script lang="ts">
	import { page } from '$app/state';

	let { data, children } = $props();

	/** Tabs are links, so each one has an address; New server defaults is its own page. */
	const TABS = [
		{ id: 'system', label: 'System' },
		{ id: 'java', label: 'Java' },
		{ id: 'snapshots', label: 'Snapshots' },
		{ id: 'defaults', label: 'New server defaults', href: '/settings/defaults' },
		{ id: 'integrations', label: 'Integrations' },
		{ id: 'security', label: 'Security' },
		{ id: 'activity', label: 'Activity' }
	];
	const current = $derived(
		page.url.pathname.startsWith('/settings/defaults') ? 'defaults' : (page.url.searchParams.get('tab') ?? 'system')
	);
</script>

<header class="settings-head">
	<h1>MineShell settings</h1>
	<p class="muted">Apply to every server on this machine.</p>
	<nav class="subtabs" aria-label="Settings sections">
		{#each TABS as tab (tab.id)}
			<a href={tab.href ?? `/settings?tab=${tab.id}`} aria-current={current === tab.id ? 'page' : undefined}>
				{tab.label}
				{#if tab.id === 'integrations' && data.integrationsWarning}
					<span class="warn-dot" title="Not set up or not working"></span>
				{/if}
			</a>
		{/each}
	</nav>
</header>

{@render children()}

<style>
	.settings-head {
		margin: 0 -2.5rem 1.5rem;
		padding: 0.3rem 2.5rem 0;
		border-bottom: 1px solid var(--line);
	}

	.settings-head p {
		margin: 0.3rem 0 1rem;
	}

	/* Scrolling, underline overlap and the right-edge fade on phones come from app.css's .subtabs. */

	.subtabs a {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.55rem 0.8rem 0.7rem;
		border-bottom: 2px solid transparent;
		color: var(--text-muted);
		text-decoration: none;
		white-space: nowrap;
		font-size: 0.93rem;
	}

	.subtabs a:hover {
		color: var(--text);
	}

	.subtabs a[aria-current='page'] {
		color: var(--text);
		border-bottom-color: var(--accent);
	}

	.warn-dot {
		width: 7px;
		height: 7px;
		border-radius: 1px;
		background: var(--warning);
	}

	@media (max-width: 60rem) {
		.settings-head {
			margin: 0 calc(var(--space-4) * -1) 1.5rem;
			padding: 0.3rem var(--space-4) 0;
		}
	}
</style>
