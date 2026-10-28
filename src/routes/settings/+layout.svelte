<script lang="ts">
	import { page } from '$app/state';

	let { data, children } = $props();

	/** Tabs are links, so each one has an address; New server defaults and Accounts are pages of their own. */
	const TABS = [
		{ id: 'system', label: 'System' },
		{ id: 'ports', label: 'Ports' },
		{ id: 'java', label: 'Java' },
		{ id: 'snapshots', label: 'Snapshots' },
		{ id: 'defaults', label: 'New server defaults', href: '/settings/defaults' },
		{ id: 'accounts', label: 'Accounts', href: '/settings/users' },
		{ id: 'integrations', label: 'Integrations' },
		{ id: 'notifications', label: 'Notifications' },
		{ id: 'updates', label: 'Updates' },
		{ id: 'activity', label: 'Activity' }
	];
	const current = $derived(
		page.url.pathname.startsWith('/settings/defaults')
			? 'defaults'
			: page.url.pathname.startsWith('/settings/users')
				? 'accounts'
				: (TABS.find((t) => !t.href && t.id === page.url.searchParams.get('tab'))?.id ?? 'system')
	);
</script>

<header class="settings-head">
	<h1>MineShell settings</h1>
	<p class="muted">Apply to every server on this machine.</p>
</header>

<!-- Apart from the header so it can stay in view under the top bar while the page scrolls. -->
<div class="settings-tabs">
	<nav class="subtabs" aria-label="Settings sections">
		{#each TABS as tab (tab.id)}
			<a href={tab.href ?? `/settings?tab=${tab.id}`} aria-current={current === tab.id ? 'page' : undefined}>
				{tab.label}
				{#if tab.id === 'integrations' && data.integrationsWarning}
					<span class="warn-dot" title="Not set up or not working"></span>
				{/if}
				{#if tab.id === 'updates' && data.updateAvailable}
					<span class="warn-dot" title="A new version is available"></span>
				{/if}
			</a>
		{/each}
	</nav>
</div>

{@render children()}

<style>
	.settings-head {
		padding-top: 0.3rem;
	}

	.settings-head p {
		margin: 0.3rem 0 1rem;
	}

	.settings-tabs {
		position: sticky;
		top: 3.25rem;
		z-index: 14;
		margin: 0 -2.5rem 1.5rem;
		padding: 0 2.5rem;
		border-bottom: 1px solid var(--line);
		background: var(--bg);
	}

	/* The tabs' look, scrolling and the right-edge fade on phones come from app.css's .subtabs. */

	.warn-dot {
		width: 7px;
		height: 7px;
		border-radius: 1px;
		background: var(--warning);
	}

	@media (max-width: 60rem) {
		.settings-tabs {
			margin: 0 calc(var(--space-4) * -1) 1.5rem;
			padding: 0 var(--space-4);
		}
	}
</style>
