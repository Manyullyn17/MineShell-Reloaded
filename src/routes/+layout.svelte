<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { THEMES, THEME_STORAGE_KEY } from '#lib/shared/themes.js';
	import { describeState } from '#lib/shared/format.js';
	import NotificationCenter from '#lib/components/NotificationCenter.svelte';
	import LogoMark from '#lib/components/LogoMark.svelte';
	import ServerIcon from '#lib/components/ServerIcon.svelte';
	import TapTips from '#lib/components/TapTips.svelte';

	let { data, children } = $props();

	let railOpen = $state(false);
	let theme = $state('deep-slate');

	$effect(() => {
		const stored = localStorage.getItem(THEME_STORAGE_KEY);
		if (stored) theme = stored;
	});

	function applyTheme(next: string) {
		theme = next;
		document.documentElement.dataset.theme = next;
		localStorage.setItem(THEME_STORAGE_KEY, next);
	}

	const bare = $derived(page.url.pathname === '/login' || page.url.pathname === '/setup');
	const instances = $derived(data.railInstances ?? []);
</script>

{#snippet themeSelect(id: string)}
	<select {id} class="theme-select" value={theme} onchange={(e) => applyTheme((e.currentTarget as HTMLSelectElement).value)}>
		{#each THEMES as option (option.id)}
			<option value={option.id}>{option.label}</option>
		{/each}
	</select>
{/snippet}

{#if bare}
	<main class="bare">
		{@render children()}
	</main>
{:else}
	<div class="shell" class:rail-open={railOpen}>
		<header class="topbar">
			<button
				class="button-quiet rail-toggle"
				onclick={() => (railOpen = !railOpen)}
				aria-expanded={railOpen}
			>
				<span aria-hidden="true">☰</span>
				<span class="visually-hidden">Toggle server list</span>
			</button>
			<a class="wordmark" href="/"><LogoMark size={26} /><span>Mine<span class="wordmark-accent">Shell</span></span></a>
			<div class="topbar-right">
				{#if data.updateAvailable}
					<a class="tag accent update-link" href="/settings?tab=updates" title="MineShell {data.updateAvailable} is available">
						Update {data.updateAvailable}
					</a>
				{/if}
				<NotificationCenter running={data.runningTasks} />
				<span class="topbar-theme">
					<label class="visually-hidden" for="theme-select">Theme</label>
					{@render themeSelect('theme-select')}
				</span>
			</div>
		</header>

		<nav class="rail" aria-label="Servers">
			<a class="rail-link" class:current={page.url.pathname === '/'} href="/" onclick={() => (railOpen = false)}>
				All servers
			</a>

			<div class="rail-section">
				<div class="rail-heading">
					<span>Servers</span>
					<a href="/instances/new" title="Add a server" aria-label="Add a server">+</a>
				</div>
				{#if instances.length === 0}
					<p class="rail-empty">No servers yet.</p>
				{:else}
					<ul>
						{#each instances as instance (instance.id)}
							{@const state = describeState(instance.active, instance.sub)}
							<li>
								<a
									class="rail-instance"
									class:current={page.url.pathname.startsWith(`/instances/${instance.id}`)}
									data-tone={state.tone}
									href="/instances/{instance.id}"
									onclick={() => (railOpen = false)}
								>
									<span class="rail-icon">
										<ServerIcon id={instance.id} name={instance.name} iconVersion={instance.iconVersion} size={32} />
										<span class="dot {state.tone}"></span>
									</span>
									<span class="rail-instance-text">
										<span class="rail-instance-name">{instance.name}</span>
										<span class="rail-instance-sub">
											{#if instance.status === 'provisioning'}
												Being set up
											{:else}
												{state.label}{state.tone === 'busy' ? '...' : ''}{instance.gaveUpAfter
													? ` · gave up after ${instance.gaveUpAfter} tries`
													: ''}{instance.players
													? ` · ${instance.players.online}/${instance.players.max}`
													: ''}
											{/if}
										</span>
									</span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<div class="rail-bottom">
				<!-- On a phone the theme lives here; the top bar has no room for it. -->
				<label class="rail-theme">
					<span>Theme</span>
					{@render themeSelect('rail-theme-select')}
				</label>
				<a class="rail-link" class:current={page.url.pathname === '/tasks'} href="/tasks" onclick={() => (railOpen = false)}>
					Activity
				</a>
				<a
					class="rail-link"
					class:current={page.url.pathname.startsWith('/settings')}
					href="/settings"
					onclick={() => (railOpen = false)}
				>
					MineShell settings
				</a>
				{#if data.authRequired}
					<form method="POST" action="/login?/logout">
						<button class="rail-link rail-signout" type="submit">Sign out</button>
					</form>
				{/if}
			</div>
		</nav>

		<button
			class="scrim"
			aria-label="Close server list"
			onclick={() => (railOpen = false)}
			tabindex={railOpen ? 0 : -1}
		></button>

		<main class="content">
			{@render children()}
		</main>

		<TapTips />
	</div>
{/if}

<style>
	.bare {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: var(--space-4);
	}

	.shell {
		min-height: 100vh;
		display: grid;
		grid-template-columns: var(--rail-width) minmax(0, 1fr);
		grid-template-rows: auto minmax(0, 1fr);
		grid-template-areas:
			'topbar topbar'
			'rail content';
	}

	.topbar {
		grid-area: topbar;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0 1.25rem;
		height: 3.25rem;
		border-bottom: 1px solid var(--line);
		background: var(--panel);
		position: sticky;
		top: 0;
		z-index: 20;
	}

	.wordmark {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: 800;
		font-size: 1.1rem;
		letter-spacing: -0.01em;
		color: var(--text);
		text-decoration: none;
	}

	.wordmark-accent {
		color: var(--accent);
	}

	.topbar-right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.update-link {
		text-decoration: none;
		white-space: nowrap;
	}

	.rail-theme {
		display: none;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin: 0 0 var(--space-2);
		padding: 0 var(--space-3);
		font-size: 0.92rem;
		color: var(--text-muted);
	}

	.theme-select {
		width: auto;
		font-size: 0.85rem;
		padding: 0.25rem 0.5rem;
		background: var(--panel-raised);
	}

	.rail-toggle {
		display: none;
		padding: 0.2rem 0.5rem;
	}

	.rail {
		grid-area: rail;
		border-right: 1px solid var(--line);
		background: var(--bg-sunken);
		padding: var(--space-4) 0.625rem;
		display: flex;
		flex-direction: column;
		gap: 1.4rem;
		overflow-y: auto;
		position: sticky;
		top: 3.25rem;
		height: calc(100vh - 3.25rem);
	}

	.rail-section ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.rail-bottom {
		margin-top: auto;
		border-top: 1px solid var(--line);
		padding-top: var(--space-3);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.rail-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 var(--space-3) 0.4rem;
		font-size: 0.78rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.rail-heading a {
		text-decoration: none;
		font-size: 1.15rem;
		line-height: 1;
		color: var(--text-muted);
		padding: 0 0.25rem;
	}

	.rail-heading a:hover {
		color: var(--accent-hover);
	}

	.rail-empty {
		padding: 0 var(--space-3);
		font-size: 0.85rem;
		color: var(--text-faint);
	}

	.rail-link,
	.rail-instance {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: var(--space-2) var(--space-3);
		color: var(--text-muted);
		text-decoration: none;
		font-size: 0.92rem;
		border-radius: var(--radius-lg);
	}

	.rail-instance {
		padding: 0.55rem var(--space-3);
	}

	.rail-link:hover,
	.rail-instance:hover {
		color: var(--text);
		background: color-mix(in srgb, var(--panel) 60%, transparent);
	}

	.rail-link.current,
	.rail-instance.current {
		color: var(--text);
		background: var(--panel);
	}

	.rail-instance {
		--row-bg: var(--bg-sunken);
	}
	.rail-instance:hover {
		--row-bg: color-mix(in srgb, var(--panel) 60%, var(--bg-sunken));
	}
	.rail-instance.current {
		--row-bg: var(--panel);
	}

	/* The status dot sits on the icon's corner, ringed in the row's colour. */
	.rail-icon {
		position: relative;
		display: inline-flex;
		flex: none;
	}

	.rail-instance .dot {
		position: absolute;
		right: -3px;
		bottom: -3px;
		width: 11px;
		height: 11px;
		box-shadow: 0 0 0 2px var(--row-bg);
	}

	.rail-instance-text {
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.rail-instance-name {
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The rail doubles as a status board: the line under the name says it. */
	.rail-instance-sub {
		font-size: 0.8rem;
		color: var(--text-faint);
	}
	.rail-instance[data-tone='running'] .rail-instance-sub {
		color: var(--accent-hover);
	}
	.rail-instance[data-tone='failed'] .rail-instance-sub {
		color: var(--error);
	}
	.rail-instance[data-tone='busy'] .rail-instance-sub {
		color: var(--warning);
	}

	.rail-signout {
		width: 100%;
		justify-content: flex-start;
		background: none;
		border: 0;
		font-weight: 400;
	}

	.content {
		grid-area: content;
		padding: var(--space-5) 2.5rem;
		min-width: 0;
	}

	.scrim {
		display: none;
		position: fixed;
		inset: 3.25rem 0 0;
		background: rgba(0, 0, 0, 0.5);
		border: 0;
		z-index: 5;
	}

	@media (max-width: 60rem) {
		.shell {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas:
				'topbar'
				'content';
		}

		.rail-toggle {
			display: inline-flex;
		}

		.topbar-theme {
			display: none;
		}

		.rail-theme {
			display: flex;
		}

		.rail {
			position: fixed;
			top: 3.25rem;
			left: 0;
			width: min(var(--rail-width), 80vw);
			/* Above the instance page's sticky header (15), below the top bar (20). */
			z-index: 18;
			transform: translateX(-100%);
			transition: transform 0.16s ease-out;
		}

		.rail-open .rail {
			transform: translateX(0);
			box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.001);
		}

		.rail-open .scrim {
			display: block;
			z-index: 17;
		}

		.content {
			padding: var(--space-4);
		}
	}
</style>
