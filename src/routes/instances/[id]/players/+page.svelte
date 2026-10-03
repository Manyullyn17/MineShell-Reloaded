<script lang="ts">
	import { enhance } from '$app/forms';
	import Flash from '$lib/components/Flash.svelte';
	import { formatRelative } from '$lib/shared/format';

	let { data, form } = $props();

	const tabs = [
		{ id: 'whitelist', label: 'Whitelist', empty: 'Nobody is whitelisted yet.' },
		{ id: 'ops', label: 'Operators', empty: 'No operators. Add yourself to use commands in-game.' },
		{ id: 'bans', label: 'Bans', empty: 'Nobody is banned.' }
	] as const;

	let current = $state<'whitelist' | 'ops' | 'bans'>('whitelist');
	let newName = $state('');

	const entries = $derived(data.lists[current]);
	const onlineNames = $derived(new Set((data.online?.names ?? []).map((n) => n.toLowerCase())));
	const activeTab = $derived(tabs.find((t) => t.id === current)!);
</script>

<Flash {form} />

{#if !data.lists.serverRunning}
	<div class="notice info">
		<p>
			The server is stopped, so MineShell edits the JSON files directly and looks up UUIDs through
			Mojang. Start the server first if you want changes to apply live.
		</p>
	</div>
{/if}

{#if data.online}
	<section class="panel">
		<h2>Online now</h2>
		{#if data.online.names.length === 0}
			<p class="muted">Nobody is connected.</p>
		{:else}
			<ul class="online">
				{#each data.online.names as name (name)}
					<li>
						<span class="mono">{name}</span>
						<form method="POST" action="?/kick" use:enhance>
							<input type="hidden" name="name" value={name} />
							<input type="hidden" name="reason" value="Kicked by an operator" />
							<button class="button-quiet">Kick</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}

<section class="panel">
	<div class="panel-head">
		<div>
			<h2>Whitelist enforcement</h2>
			<p>
				{data.lists.whitelistEnforced
					? 'Only whitelisted players can join.'
					: 'Anyone who can reach the port can join.'}
			</p>
		</div>
		<form method="POST" action="?/whitelist" use:enhance>
			<input type="hidden" name="enabled" value={String(!data.lists.whitelistEnforced)} />
			<button class={data.lists.whitelistEnforced ? '' : 'button-primary'}>
				{data.lists.whitelistEnforced ? 'Turn whitelist off' : 'Turn whitelist on'}
			</button>
		</form>
	</div>
</section>

<section class="panel">
	<div class="tabs" role="tablist">
		{#each tabs as tab (tab.id)}
			<button role="tab" aria-selected={current === tab.id} onclick={() => (current = tab.id)}>
				{tab.label}
				<span class="count">{data.lists[tab.id].length}</span>
			</button>
		{/each}
	</div>

	<form method="POST" action="?/add" use:enhance class="add-row">
		<input type="hidden" name="list" value={current} />
		<div class="field grow">
			<label for="player-name">Player name</label>
			<input id="player-name" name="name" bind:value={newName} placeholder="Notch" autocomplete="off" />
		</div>
		<button class="button-primary" type="submit">Add to {activeTab.label.toLowerCase()}</button>
	</form>

	{#if entries.length === 0}
		<div class="empty"><p>{activeTab.empty}</p></div>
	{:else}
		<table>
			<thead>
				<tr>
					<th>Player</th>
					<th>UUID</th>
					<th><span class="visually-hidden">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				{#each entries as entry (entry.uuid)}
					<tr>
						<td>{entry.name}</td>
						<td class="mono small">{entry.uuid}</td>
						<td class="right">
							<form method="POST" action="?/remove" use:enhance>
								<input type="hidden" name="list" value={current} />
								<input type="hidden" name="name" value={entry.name} />
								<button class="button-quiet button-danger">Remove</button>
							</form>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<section class="panel">
	<h2>Player data</h2>
	<p class="muted small">
		Inventory, stats and everything else the server saved about each player who has joined. Players can be edited
		while they are offline.
	</p>
	{#if data.playerFiles.length === 0}
		<div class="empty"><p>No player has joined this server yet.</p></div>
	{:else}
		<table>
			<thead>
				<tr>
					<th>Player</th>
					<th>UUID</th>
					<th>Last saved</th>
					<th><span class="visually-hidden">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.playerFiles as file (file.uuid)}
					<tr>
						<td>
							{file.name ?? 'Unknown name'}
							{#if file.name && onlineNames.has(file.name.toLowerCase())}<span class="tag accent">online</span>{/if}
						</td>
						<td class="mono small">{file.uuid}</td>
						<td class="small muted">{formatRelative(file.modifiedAt)}</td>
						<td class="right"><a class="button button-quiet" href="/instances/{encodeURIComponent(data.instance.id)}/players/{file.uuid}">Open</a></td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<style>
	.tabs {
		display: flex;
		gap: var(--space-1);
		border-bottom: 1px solid var(--line);
		margin-bottom: var(--space-4);
	}

	.tabs button {
		background: none;
		border: 0;
		border-bottom: 2px solid transparent;
		border-radius: 0;
		color: var(--text-muted);
	}

	.tabs button[aria-selected='true'] {
		color: var(--text);
		border-bottom-color: var(--accent);
	}

	.count {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--text-faint);
	}

	.add-row {
		display: flex;
		gap: var(--space-3);
		align-items: flex-end;
		flex-wrap: wrap;
		margin-bottom: var(--space-4);
	}

	.grow {
		flex: 1 1 14rem;
		margin-bottom: 0;
	}

	.online {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-1);
	}

	.online li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-1) 0;
		border-bottom: 1px solid var(--line);
	}

	.right {
		text-align: right;
	}

	td button,
	td .button {
		font-size: 0.82rem;
		padding: 0.2rem 0.5rem;
	}
</style>
