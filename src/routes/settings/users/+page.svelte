<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import Flash from '#lib/components/Flash.svelte';
	import OneTimePassword from '#lib/components/OneTimePassword.svelte';
	import { formatDateTime } from '#lib/shared/format.js';

	let { data, form } = $props();
	const created = $derived((form as { created?: { id: string; username: string; password: string } } | null)?.created ?? null);

	const role = (a: (typeof data.accounts)[number]) => (a.isOwner ? 'Owner' : a.isGlobalAdmin ? 'Admin' : '');
	const state = (a: (typeof data.accounts)[number]) =>
		a.disabled ? 'Disabled' : a.mustChangePassword ? 'Has not picked a password yet' : a.sessions ? `Signed in on ${a.sessions}` : 'Not signed in';
</script>

<svelte:head><title>Accounts - MineShell</title></svelte:head>

{#if created}
	<OneTimePassword username={created.username} password={created.password}>
		<a href="/settings/users/{created.id}">Choose what {created.username} may do</a>; a new account can do nothing yet.
	</OneTimePassword>
{:else}
	<Flash {form} />
{/if}

<section class="panel">
	<h2>Accounts</h2>
	<p class="muted">
		Who can sign in to MineShell. The owner and MineShell admins may do everything; anyone else only what they are given
		per server.
	</p>
	<div class="table-box">
		<table>
			<thead>
				<tr><th>Name</th><th>Role</th><th>Servers</th><th>State</th><th class="added">Added</th></tr>
			</thead>
			<tbody>
				{#each data.accounts as account (account.id)}
					<tr class:disabled={account.disabled}>
						<td><a href="/settings/users/{account.id}">{account.username}</a></td>
						<td>{#if role(account)}<span class="tag accent">{role(account)}</span>{/if}</td>
						<td class="small">{account.isOwner || account.isGlobalAdmin ? 'All' : account.servers}</td>
						<td class="small muted">{state(account)}</td>
						<td class="small faint added">{formatDateTime(account.createdAt)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

<section class="panel">
	<h2>Add an account</h2>
	<p class="muted">
		It gets a one-time password, shown here once; the person picks their own when they first sign in. Then choose which
		servers they may use and how.
	</p>
	<form method="POST" action="?/create" use:enhance class="add-form">
		<div class="field">
			<label for="new-account">Username</label>
			<!-- Not a sign-in: its own name, so browsers do not offer the login's saved names, and password managers told to keep out. -->
			<input
				id="new-account"
				name="newAccount"
				autocomplete="off"
				data-1p-ignore
				data-lpignore="true"
				data-bwignore
				data-form-type="other"
				minlength="2"
				maxlength="32"
				required
			/>
			<p class="hint">Letters, digits, dots, dashes and underscores.</p>
		</div>
		<div class="check field">
			<input id="canCreate" name="canCreate" type="checkbox" />
			<label for="canCreate">May add servers (and becomes admin of what they add)</label>
		</div>
		{#if data.owner}
			<div class="check field">
				<input id="globalAdmin" name="globalAdmin" type="checkbox" />
				<label for="globalAdmin">MineShell admin: every server, MineShell settings and other accounts</label>
			</div>
		{/if}
		<button class="button-primary" type="submit">Add account</button>
	</form>
</section>

<style>
	.add-form {
		max-width: 32rem;
	}

	tr.disabled td {
		opacity: 0.6;
	}

	/* A phone has room for who and what, not when. */
	@media (max-width: 40rem) {
		.added {
			display: none;
		}
	}
</style>
