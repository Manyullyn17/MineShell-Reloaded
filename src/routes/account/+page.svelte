<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import Flash from '#lib/components/Flash.svelte';
	import { formatDateTime } from '#lib/shared/format.js';

	let { data, form } = $props();

	const ROLE: Record<string, string> = {
		owner: 'The owner: everything, everywhere.',
		admin: 'A MineShell admin: every server and MineShell settings.',
		user: 'Access to the servers and features given to you.'
	};

	/** A browser's user agent, shortened to what tells sessions apart. */
	function device(agent: string | null): string {
		if (!agent) return 'Unknown browser';
		const browser = agent.match(/(Firefox|Edg|OPR|Chrome|Safari)\/[\d.]+/)?.[1]?.replace('Edg', 'Edge').replace('OPR', 'Opera') ?? 'Browser';
		const system = agent.match(/(Windows|Android|iPhone|iPad|Mac OS X|Linux)/)?.[1]?.replace('Mac OS X', 'macOS') ?? '';
		return system ? `${browser} on ${system}` : browser;
	}
</script>

<svelte:head><title>Your account - MineShell</title></svelte:head>

<header class="page-head">
	<div>
		<h1>Your account</h1>
		{#if data.account}<p class="muted"><strong>{data.account.username}</strong> · {ROLE[data.account.role]}</p>{/if}
	</div>
</header>

<Flash {form} />

{#if !data.account}
	<section class="panel">
		<p>Sign-in is off (<code>MINESHELL_AUTH=off</code>), so there is no account to look after.</p>
	</section>
{:else}
	{#if data.account.mustChangePassword}
		<div class="notice warning">
			<p>You were given this password by someone else. Pick your own to go on; until then MineShell shows nothing else.</p>
		</div>
	{/if}

	<section class="panel">
		<h2>Password</h2>
		<form method="POST" action="?/password" use:enhance class="password-form">
			<!-- For password managers: which account this is. -->
			<input type="text" name="username" autocomplete="username" value={data.account.username} hidden readonly />
			{#if !data.account.mustChangePassword}
				<div class="field">
					<label for="current">Current password</label>
					<input id="current" name="current" type="password" autocomplete="current-password" required />
				</div>
			{/if}
			<div class="grid-2">
				<div class="field">
					<label for="password">New password</label>
					<input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required />
					<p class="hint">At least 8 characters.</p>
				</div>
				<div class="field">
					<label for="confirm">New password again</label>
					<input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" required />
				</div>
			</div>
			<div class="check field">
				<input id="signOutEverywhere" name="signOutEverywhere" type="checkbox" checked />
				<label for="signOutEverywhere">Sign out every other device</label>
			</div>
			<button class="button-primary" type="submit">Change password</button>
		</form>
	</section>

	{#if !data.account.mustChangePassword}
		<section class="panel">
			<div class="panel-head">
				<div>
					<h2>Where you are signed in</h2>
					<p>Each browser stays signed in for 30 days.</p>
				</div>
				{#if data.account.sessions.length > 1}
					<form method="POST" action="?/signOutOthers" use:enhance>
						<button type="submit">Sign out everywhere else</button>
					</form>
				{/if}
			</div>
			<ul class="sessions">
				{#each data.account.sessions as session (session.createdAt)}
					<li>
						<span>{device(session.userAgent)}</span>
						<span class="muted small">signed in {formatDateTime(session.createdAt)}{session.current ? ' · this browser' : ''}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
{/if}

<style>
	.password-form {
		max-width: 40rem;
	}

	.sessions {
		list-style: none;
		margin: var(--space-3) 0 0;
		padding: 0;
	}

	.sessions li {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--space-2);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--line);
	}

	.page-head {
		margin-bottom: var(--space-5);
	}

	.page-head p {
		margin: var(--space-1) 0 0;
	}

	.notice {
		margin-bottom: var(--space-4);
	}
</style>
