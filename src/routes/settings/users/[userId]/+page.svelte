<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import Flash from '#lib/components/Flash.svelte';
	import OneTimePassword from '#lib/components/OneTimePassword.svelte';
	import { streamed } from '#lib/shared/streamed.svelte.js';
	import { formatDateTime } from '#lib/shared/format.js';
	import { FULL_TRUST, PERMISSION_GROUPS } from '#lib/shared/access.js';

	let { data, form } = $props();
	const reset = $derived((form as { reset?: { username: string; password: string } } | null)?.reset ?? null);
	const playersInfo = streamed(() => data.players, () => data.account.id);
	const knownPlayers = $derived((playersInfo.ready ? playersInfo.value : null) ?? {});

	type Level = 'none' | 'custom' | 'admin';
	type Scope = 'none' | 'all' | 'selected';
	type Editor = { level: Level; playerView: Scope; playerEdit: Scope };

	/** Each server's editor, from the saved access; re-read after every save (see CLAUDE.md, "UI pitfalls"). */
	function editors(): Record<string, Editor> {
		return Object.fromEntries(
			data.servers.map((s) => {
				const g = data.grants[s.id];
				return [s.id, { level: g ? (g.admin ? 'admin' : 'custom') : 'none', playerView: g?.playerView ?? 'none', playerEdit: g?.playerEdit ?? 'none' }];
			})
		);
	}
	// svelte-ignore state_referenced_locally
	let editor = $state(editors());
	$effect(() => {
		editor = editors();
	});

	const keep = () => async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => update({ reset: false });

	function summary(id: string): string {
		const g = data.grants[id];
		if (!g) return 'No access';
		if (g.admin) return 'Admin';
		const parts = [g.permissions.length ? `${g.permissions.length} permission${g.permissions.length === 1 ? '' : 's'}` : 'can see it'];
		const scopeText = (s: Scope, uuids: string[]) => (s === 'all' ? 'all players' : `${uuids.length} player${uuids.length === 1 ? '' : 's'}`);
		if (g.playerEdit !== 'none') parts.push(`edits ${scopeText(g.playerEdit, g.editUuids)}`);
		else if (g.playerView !== 'none') parts.push(`sees ${scopeText(g.playerView, g.viewUuids)}`);
		return parts.join(', ');
	}

	/** Known players of a server, plus chosen ones it has no file for (yet). */
	function playerChoices(id: string, chosen: string[]) {
		const known = knownPlayers[id] ?? [];
		const extra = chosen.filter((u) => !known.some((p) => p.uuid === u)).map((uuid) => ({ uuid, name: null }));
		return [...known, ...extra];
	}

	/** The two player data rows of the editor: seeing and editing. */
	const scopeRows = (grant: (typeof data.grants)[string] | undefined) => [
		{ key: 'playerView' as const, label: 'See', uuids: grant?.viewUuids ?? [], field: 'viewUuid', extra: 'viewExtra' },
		{ key: 'playerEdit' as const, label: 'Edit', uuids: grant?.editUuids ?? [], field: 'editUuid', extra: 'editExtra' }
	];

	const roleText = $derived(
		data.account.isOwner ? 'Owner' : data.account.isGlobalAdmin ? 'MineShell admin' : null
	);
</script>

<svelte:head><title>{data.account.username} - Accounts - MineShell</title></svelte:head>

<p class="back"><a href="/settings/users">← Accounts</a></p>
<header class="account-head">
	<h2>{data.account.username}</h2>
	{#if roleText}<span class="tag accent">{roleText}</span>{/if}
	{#if data.account.disabled}<span class="tag warn">Disabled</span>{/if}
	{#if data.account.mustChangePassword}<span class="tag">Has not picked a password yet</span>{/if}
	<span class="muted small">added {formatDateTime(data.account.createdAt)} · signed in on {data.account.sessions}</span>
</header>

{#if reset}
	<OneTimePassword username={reset.username} password={reset.password} />
{:else}
	<Flash {form} />
{/if}

{#if !data.manageable}
	<div class="notice">
		<p>
			{#if data.account.isOwner}
				The owner account is changed only by its owner, on {data.self ? '' : 'their '}<a href="/account">account page</a>.
			{:else}
				A MineShell admin's account is changed only by the owner.
			{/if}
		</p>
	</div>
{:else}
	<section class="panel">
		<h2>Account</h2>
		<form method="POST" action="?/flags" use:enhance={keep} class="flags">
			<div class="check field">
				<input id="canCreate" name="canCreate" type="checkbox" checked={data.account.canCreate} />
				<label for="canCreate">May add servers (and becomes admin of what they add)</label>
			</div>
			{#if data.owner}
				<div class="check field">
					<input id="globalAdmin" name="globalAdmin" type="checkbox" checked={data.account.isGlobalAdmin} />
					<label for="globalAdmin">MineShell admin: every server, MineShell settings and other accounts</label>
				</div>
			{:else}
				<p class="muted small">Only the owner makes MineShell admins.</p>
			{/if}
			<button type="submit">Save</button>
		</form>

		<div class="actions">
			<form
				method="POST"
				action="?/resetPassword"
				use:enhance
				onsubmit={(e) => {
					if (!confirm(`Give ${data.account.username} a new one-time password? They are signed out everywhere and pick their own at the next sign-in.`)) e.preventDefault();
				}}
			>
				<button type="submit">Reset password</button>
			</form>
			<form method="POST" action="?/signOut" use:enhance>
				<button type="submit" disabled={!data.account.sessions}>Sign out everywhere</button>
			</form>
			{#if data.account.disabled}
				<form method="POST" action="?/enable" use:enhance>
					<button type="submit">Enable</button>
				</form>
			{:else}
				<form method="POST" action="?/disable" use:enhance>
					<button type="submit" class="button-danger">Disable</button>
				</form>
			{/if}
		</div>
		<p class="muted small">Disabling signs them out everywhere and keeps them out until enabled again; their access stays as it is.</p>

		<details class="delete">
			<summary>Delete the account</summary>
			<form method="POST" action="?/delete" use:enhance class="inline-row">
				<input name="confirm" placeholder="Type {data.account.username}" aria-label="Type the username to confirm" autocomplete="off" />
				<button type="submit" class="button-danger">Delete</button>
			</form>
			<p class="muted small">Its access to every server goes with it. Disabling keeps it, for later.</p>
		</details>
	</section>

	<section class="panel">
		<h2>Servers</h2>
		{#if data.account.isGlobalAdmin}
			<p class="muted">
				A MineShell admin may do everything on every server. What is set below applies if that is taken away.
			</p>
		{:else}
			<p class="muted">What {data.account.username} may do on each server. Servers left at "No access" do not show for them.</p>
		{/if}

		{#each data.servers as server (server.id)}
			{@const grant = data.grants[server.id]}
			{@const ed = editor[server.id]}
			<details class="server">
				<summary><strong>{server.name}</strong> <span class="muted small">{summary(server.id)}</span></summary>
				<form method="POST" action="?/access" use:enhance={keep}>
					<input type="hidden" name="instanceId" value={server.id} />
					<div class="levels" role="radiogroup" aria-label="Access to {server.name}">
						<label class="check"><input type="radio" name="level" value="none" bind:group={ed.level} /> No access</label>
						<label class="check"><input type="radio" name="level" value="custom" bind:group={ed.level} /> Chosen permissions</label>
						<label class="check"><input type="radio" name="level" value="admin" bind:group={ed.level} /> Admin of this server</label>
					</div>

					{#if ed.level === 'admin'}
						<p class="muted small">
							Everything on this server, including what is added to MineShell later, but not other servers, MineShell
							settings or accounts. Taking it away gives back the permissions chosen before.
						</p>
					{:else if ed.level === 'custom'}
						<p class="muted small">Seeing the server (overview, mods, players, world, map) comes with any access.</p>
						<div class="groups">
							{#each PERMISSION_GROUPS as group (group.label)}
								<fieldset>
									<legend>{group.label}</legend>
									{#each group.permissions as p (p.id)}
										<label class="check perm">
											<input type="checkbox" name="permission" value={p.id} checked={grant?.permissions.includes(p.id) ?? false} />
											<span>
												{p.label}
												{#if FULL_TRUST.includes(p.id)}<span class="tag warn" title="Can run programs on this machine as MineShell, and through that reach everything">full trust</span>{/if}
												<span class="hint">{p.hint}</span>
											</span>
										</label>
									{/each}
								</fieldset>
							{/each}
						</div>

						<fieldset class="players">
							<legend>Player data (inventories, ender chest, effects, NBT)</legend>
							{#each scopeRows(grant) as row (row.key)}
								<div class="scope">
									<span class="scope-label">{row.label}</span>
									<label class="check"><input type="radio" name={row.key} value="none" bind:group={ed[row.key]} /> nobody's</label>
									<label class="check"><input type="radio" name={row.key} value="all" bind:group={ed[row.key]} /> every player's (also later ones)</label>
									<label class="check"><input type="radio" name={row.key} value="selected" bind:group={ed[row.key]} /> these players'</label>
								</div>
								{#if ed[row.key] === 'selected'}
									<div class="picks">
										{#if !playersInfo.ready}
											<p class="muted small">Looking for the server's players...</p>
										{/if}
										{#each playerChoices(server.id, row.uuids) as player (player.uuid)}
											<label class="check">
												<input type="checkbox" name={row.field} value={player.uuid} checked={row.uuids.includes(player.uuid)} />
												{player.name ?? player.uuid}
												{#if player.name}<span class="faint small mono">{player.uuid}</span>{/if}
											</label>
										{/each}
										<input name={row.extra} class="mono" placeholder="More by UUID" aria-label="More players by UUID" autocomplete="off" />
										<p class="muted small">Only these players: someone who joins later is not included.</p>
									</div>
								{/if}
							{/each}
							<p class="muted small">Editing a player includes seeing them.</p>
						</fieldset>
					{/if}
					<button class="button-primary" type="submit">Save</button>
				</form>
			</details>
		{:else}
			<p class="muted">There are no servers yet.</p>
		{/each}
	</section>
{/if}

<style>
	.back {
		margin: 0 0 var(--space-2);
	}

	.account-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		margin-bottom: var(--space-4);
	}

	.account-head h2 {
		margin: 0;
	}

	.flags {
		max-width: 40rem;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-4);
	}

	.delete {
		margin-top: var(--space-4);
	}

	.server {
		border-top: 1px solid var(--line);
		padding: var(--space-3) 0;
	}

	.server summary {
		cursor: pointer;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-3);
		align-items: baseline;
	}

	.server form {
		margin-top: var(--space-3);
		display: grid;
		gap: var(--space-3);
		justify-items: start;
	}

	.levels,
	.scope {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-4);
	}

	.scope-label {
		min-width: 2.5rem;
		color: var(--text-muted);
	}

	.groups {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
		gap: var(--space-3);
		width: 100%;
	}

	fieldset {
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3) var(--space-3);
		margin: 0;
		min-width: 0;
	}

	legend {
		padding: 0 var(--space-1);
		color: var(--text-muted);
		font-size: 0.85rem;
	}

	.perm {
		align-items: flex-start;
		margin-top: var(--space-2);
	}

	.perm .hint {
		display: block;
		margin: 0.1rem 0 0;
		font-size: 0.8rem;
		color: var(--text-faint);
	}

	.players {
		width: 100%;
		display: grid;
		gap: var(--space-2);
	}

	.picks {
		display: grid;
		gap: var(--space-1);
		padding-left: var(--space-5);
	}

	.picks input[name$='Extra'] {
		max-width: 26rem;
	}
</style>
