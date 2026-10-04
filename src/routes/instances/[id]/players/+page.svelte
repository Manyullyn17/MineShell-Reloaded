<script lang="ts">
	import { enhance } from '$app/forms';
	import Flash from '#lib/components/Flash.svelte';
	import { formatRelative } from '#lib/shared/format.js';

	let { data, form } = $props();

	const tabs = [
		{ id: 'whitelist', label: 'Whitelist', empty: 'Nobody is whitelisted yet.' },
		{ id: 'ops', label: 'Operators', empty: 'No operators. Add yourself to use commands in-game.' },
		{ id: 'bans', label: 'Bans', empty: 'Nobody is banned.' },
		{ id: 'ipBans', label: 'IP bans', empty: 'No addresses are banned.' }
	] as const;

	let current = $state<'whitelist' | 'ops' | 'bans' | 'ipBans'>('whitelist');
	let newName = $state('');
	let newReason = $state('');
	// Shared by the Kick, Ban and Ban IP buttons of the online list.
	let onlineReason = $state('');
	const isBanList = $derived(current === 'bans' || current === 'ipBans');
	const keepValues = () => async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) =>
		update({ reset: false });

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
			<div class="field reason">
				<label for="online-reason">Reason</label>
				<input id="online-reason" bind:value={onlineReason} maxlength="200" placeholder="Shown to the player" />
			</div>
			<ul class="online">
				{#each data.online.names as name (name)}
					<li>
						<span class="mono">{name}</span>
						<form method="POST" use:enhance class="row">
							<input type="hidden" name="name" value={name} />
							<input type="hidden" name="reason" value={onlineReason || 'Kicked by an operator'} />
							<button class="button-quiet" formaction="?/kick">Kick</button>
						</form>
						<form method="POST" action="?/add" use:enhance class="row">
							<input type="hidden" name="name" value={name} />
							<input type="hidden" name="reason" value={onlineReason} />
							<button class="button-quiet button-danger" name="list" value="bans">Ban</button>
							<button
								class="button-quiet button-danger"
								name="list"
								value="ipBans"
								title="Bans the address {name} is connected from"
							>
								Ban IP
							</button>
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
			<label for="player-name">
				{current === 'ipBans'
					? data.lists.serverRunning
						? 'IP address, or an online player'
						: 'IP address'
					: 'Player name'}
			</label>
			<input
				id="player-name"
				name="name"
				bind:value={newName}
				placeholder={current === 'ipBans' ? '203.0.113.7' : 'Notch'}
				autocomplete="off"
			/>
		</div>
		{#if isBanList}
			<div class="field grow">
				<label for="ban-reason">Reason</label>
				<input id="ban-reason" name="reason" bind:value={newReason} maxlength="200" placeholder="Banned by an operator." />
			</div>
		{/if}
		{#if current === 'ops' && !data.lists.serverRunning}
			<div class="field">
				<label for="op-level">Level</label>
				<select id="op-level" name="level" class="level">
					{#each [4, 3, 2, 1] as level (level)}<option value={level}>{level}</option>{/each}
				</select>
			</div>
		{/if}
		<button class="button-primary" type="submit">
			{isBanList ? 'Ban' : `Add to ${activeTab.label.toLowerCase()}`}
		</button>
	</form>
	{#if current === 'ops'}
		<p class="hint">
			{data.lists.serverRunning
				? `While the server runs, new operators get level ${data.lists.defaultOpLevel} (op-permission-level in server.properties); stop it to pick or change levels.`
				: 'Level 4 can do everything, including stopping the server; 2 is enough for most commands, 1 only bypasses spawn protection.'}
		</p>
	{/if}

	{#if entries.length === 0}
		<div class="empty"><p>{activeTab.empty}</p></div>
	{:else}
		<table>
			<thead>
				<tr>
					<th>{current === 'ipBans' ? 'Address' : 'Player'}</th>
					{#if current === 'whitelist'}<th>UUID</th>{/if}
					{#if current === 'ops'}<th>Level</th><th>Bypasses player limit</th>{/if}
					{#if isBanList}<th>Reason</th><th>Banned</th><th>By</th>{/if}
					<th><span class="visually-hidden">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				{#each entries as entry (entry.key)}
					<tr>
						<td class:mono={current === 'ipBans'}>{entry.name}</td>
						{#if current === 'whitelist'}<td class="mono small">{entry.uuid}</td>{/if}
						{#if current === 'ops'}
							{#if data.lists.serverRunning}
								<td class="mono">{entry.level}</td>
								<td>{entry.bypassesPlayerLimit ? 'Yes' : 'No'}</td>
							{:else}
								<td colspan="2">
									<form method="POST" action="?/opOptions" use:enhance={keepValues} class="row">
										<input type="hidden" name="name" value={entry.key} />
										<select name="level" class="level" aria-label="Level of {entry.name}">
											{#each [4, 3, 2, 1] as level (level)}
												<option value={level} selected={entry.level === level}>{level}</option>
											{/each}
										</select>
										<span class="check">
											<input
												id="bypass-{entry.key}"
												name="bypass"
												type="checkbox"
												checked={entry.bypassesPlayerLimit}
											/>
											<label for="bypass-{entry.key}">Bypasses limit</label>
										</span>
										<button class="button-quiet">Save</button>
									</form>
								</td>
							{/if}
						{/if}
						{#if isBanList}
							<td>{entry.reason ?? ''}</td>
							<td class="small muted nowrap">{entry.created?.slice(0, 16) ?? ''}</td>
							<td class="small muted">{entry.source ?? ''}</td>
						{/if}
						<td class="right">
							<form method="POST" action="?/remove" use:enhance>
								<input type="hidden" name="list" value={current} />
								<input type="hidden" name="name" value={entry.key} />
								<button class="button-quiet button-danger">{isBanList ? 'Pardon' : 'Remove'}</button>
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

	.online li form {
		gap: var(--space-1);
	}

	.online li form:first-of-type {
		margin-left: auto;
	}

	.reason {
		max-width: 26rem;
	}

	.level {
		width: auto;
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
