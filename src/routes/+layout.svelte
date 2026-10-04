<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { THEMES, THEME_STORAGE_KEY } from '#lib/shared/themes.js';
	import { describeState } from '#lib/shared/format.js';
	import TaskToasts from '#lib/components/TaskToasts.svelte';

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
			<a class="wordmark" href="/">MineShell</a>
			<div class="topbar-right">
				{#if data.runningTasks > 0}
					<a class="button-quiet button task-pill" href="/tasks">
						<span class="dot busy"></span>
						{data.runningTasks} running
					</a>
				{/if}
				<label class="visually-hidden" for="theme-select">Theme</label>
				<select
					id="theme-select"
					class="theme-select"
					value={theme}
					onchange={(e) => applyTheme((e.currentTarget as HTMLSelectElement).value)}
				>
					{#each THEMES as option (option.id)}
						<option value={option.id}>{option.label}</option>
					{/each}
				</select>
			</div>
		</header>

		<nav class="rail" aria-label="Servers">
			<div class="rail-section">
				<a class="rail-link" class:current={page.url.pathname === '/'} href="/">Overview</a>
			</div>

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
									<span class="dot {state.tone}"></span>
									<span class="rail-instance-name">{instance.name}</span>
									{#if instance.status === 'provisioning'}
										<span class="tag warn">setup</span>
									{/if}
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<div class="rail-section rail-bottom">
				<a class="rail-link" class:current={page.url.pathname === '/tasks'} href="/tasks">
					Activity
				</a>
				<a
					class="rail-link"
					class:current={page.url.pathname.startsWith('/settings')}
					href="/settings"
				>
					Settings
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

		<TaskToasts />
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
		padding: 0 var(--space-4);
		height: 3rem;
		border-bottom: 1px solid var(--line);
		background: var(--panel);
		position: sticky;
		top: 0;
		z-index: 20;
	}

	.wordmark {
		font-weight: 600;
		font-size: 1rem;
		letter-spacing: 0.01em;
		color: var(--text);
		text-decoration: none;
	}

	.topbar-right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.task-pill {
		font-size: 0.82rem;
		padding: 0.2rem 0.55rem;
	}

	.theme-select {
		width: auto;
		font-size: 0.82rem;
		padding: 0.2rem 0.4rem;
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
		padding: var(--space-4) 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
		overflow-y: auto;
		position: sticky;
		top: 3rem;
		height: calc(100vh - 3rem);
	}

	.rail-section ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.rail-bottom {
		margin-top: auto;
		border-top: 1px solid var(--line);
		padding-top: var(--space-3);
	}

	.rail-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 var(--space-4) var(--space-2);
		font-size: 0.78rem;
		color: var(--text-faint);
	}

	.rail-heading a {
		text-decoration: none;
		font-size: 1.1rem;
		line-height: 1;
		color: var(--text-muted);
		padding: 0 0.25rem;
	}

	.rail-heading a:hover {
		color: var(--accent-hover);
	}

	.rail-empty {
		padding: 0 var(--space-4);
		font-size: 0.85rem;
		color: var(--text-faint);
	}

	.rail-link,
	.rail-instance {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 0.4rem var(--space-4);
		color: var(--text-muted);
		text-decoration: none;
		font-size: 0.9rem;
		border-left: 3px solid transparent;
	}

	.rail-link:hover,
	.rail-instance:hover {
		color: var(--text);
		background: var(--panel);
	}

	.rail-link.current,
	.rail-instance.current {
		color: var(--text);
		background: var(--panel);
		border-left-color: var(--accent);
	}

	/* The rail doubles as a status board: colour on the edge, not the label. */
	.rail-instance[data-tone='running'] {
		border-left-color: color-mix(in srgb, var(--success) 55%, transparent);
	}
	.rail-instance[data-tone='failed'] {
		border-left-color: var(--error);
	}
	.rail-instance.current[data-tone='running'] {
		border-left-color: var(--success);
	}

	.rail-instance-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rail-signout {
		width: 100%;
		justify-content: flex-start;
		background: none;
		border: 0;
		border-left: 3px solid transparent;
		border-radius: 0;
		font-weight: 400;
	}

	.content {
		grid-area: content;
		padding: var(--space-5);
		min-width: 0;
	}

	.scrim {
		display: none;
		position: fixed;
		inset: 3rem 0 0;
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

		.rail {
			position: fixed;
			top: 3rem;
			left: 0;
			width: min(var(--rail-width), 80vw);
			z-index: 10;
			transform: translateX(-100%);
			transition: transform 0.16s ease-out;
		}

		.rail-open .rail {
			transform: translateX(0);
			box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.001);
		}

		.rail-open .scrim {
			display: block;
		}

		.content {
			padding: var(--space-4);
		}
	}
</style>
