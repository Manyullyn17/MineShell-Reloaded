<script lang="ts">
	import { enhance } from '$app/forms';
	import Flash from '#lib/components/Flash.svelte';
	import { avatarTone } from '#lib/shared/avatar.js';
	import { formatRelative } from '#lib/shared/format.js';

	let { data, form } = $props();

	const keepValues = () => async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) =>
		update({ reset: false });

	let newName = $state('');
	let newReason = $state('');
	/** An address in the name field bans the address, not a player. */
	const isAddress = $derived(/^[\d.:a-fA-F]+$/.test(newName.trim()) && /[.:]/.test(newName));

	/**
	 * One row per person, whichever lists they are on: the whitelist, operators,
	 * bans, who is online and who has player data. Names match case-insensitively,
	 * as Minecraft's do.
	 */
	type Person = {
		key: string;
		name: string;
		uuid: string | null;
		/** The whitelist entry's own key, or null when not whitelisted. */
		whitelisted: string | null;
		op: { level?: number; bypassesPlayerLimit?: boolean; key: string } | null;
		ban: { reason?: string; created?: string; source?: string; key: string } | null;
		online: boolean;
		file: { uuid: string; modifiedAt: number } | null;
	};
	const people = $derived.by(() => {
		const byName = new Map<string, Person>();
		const get = (name: string, uuid: string | null = null) => {
			const id = name.toLowerCase();
			let person = byName.get(id);
			if (!person) {
				person = { key: id, name, uuid, whitelisted: null, op: null, ban: null, online: false, file: null };
				byName.set(id, person);
			}
			if (!person.uuid && uuid) person.uuid = uuid;
			return person;
		};
		for (const e of data.lists.whitelist) get(e.name, e.uuid).whitelisted = e.key;
		for (const e of data.lists.ops)
			get(e.name, e.uuid).op = { level: e.level, bypassesPlayerLimit: e.bypassesPlayerLimit, key: e.key };
		for (const e of data.lists.bans)
			get(e.name, e.uuid).ban = { reason: e.reason, created: e.created, source: e.source, key: e.key };
		for (const name of data.online?.names ?? []) get(name).online = true;
		for (const f of data.playerFiles) {
			if (!f.name) continue;
			get(f.name, f.uuid).file = { uuid: f.uuid, modifiedAt: f.modifiedAt };
		}
		return [...byName.values()].sort(
			(a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)
		);
	});
	/** Player data files whose owner's name is not known. */
	const unnamedFiles = $derived(data.playerFiles.filter((f) => !f.name));

	const FILTERS = [
		{ id: 'all', label: 'All', test: () => true },
		{ id: 'online', label: 'Online', test: (p: Person) => p.online },
		{ id: 'whitelisted', label: 'Whitelisted', test: (p: Person) => p.whitelisted },
		{ id: 'ops', label: 'Operators', test: (p: Person) => !!p.op },
		{ id: 'banned', label: 'Banned', test: (p: Person) => !!p.ban }
	] as const;
	let filter = $state<(typeof FILTERS)[number]['id']>('all');
	const shown = $derived(people.filter(FILTERS.find((f) => f.id === filter)!.test));
	const playerUrl = (uuid: string) => `/instances/${encodeURIComponent(data.instance.id)}/players/${uuid}`;
</script>

<Flash {form} />

<section class="bar">
	<form method="POST" action="?/whitelist" use:enhance class="enforce">
		<input type="hidden" name="enabled" value={String(!data.lists.whitelistEnforced)} />
		<button
			type="submit"
			class="switch"
			role="switch"
			aria-checked={data.lists.whitelistEnforced}
			aria-label="Whitelist"
		></button>
		<span>
			<strong>Whitelist {data.lists.whitelistEnforced ? 'on' : 'off'}</strong>
			<span class="muted small">
				{data.lists.whitelistEnforced ? 'Only whitelisted players can join.' : 'Anyone who can reach the port can join.'}
			</span>
		</span>
	</form>

	<form method="POST" action="?/add" use:enhance={keepValues} class="add">
		<input
			name="name"
			bind:value={newName}
			placeholder={data.lists.serverRunning ? 'Player name or IP address' : 'Player name or IP address'}
			aria-label="Player name or IP address"
			autocomplete="off"
		/>
		<input name="reason" bind:value={newReason} maxlength="200" placeholder="Reason, for a ban" aria-label="Ban reason" />
		{#if !data.lists.serverRunning}
			<select name="level" class="level" aria-label="Operator level" title="Level for Make operator">
				{#each [4, 3, 2, 1] as level (level)}<option value={level}>op {level}</option>{/each}
			</select>
		{/if}
		<button class="button-primary" name="list" value="whitelist" disabled={!newName.trim() || isAddress}>
			Add to whitelist
		</button>
		<button name="list" value="ops" disabled={!newName.trim() || isAddress}>Make operator</button>
		<button class="button-danger" name="list" value={isAddress ? 'ipBans' : 'bans'} disabled={!newName.trim()}>
			{isAddress ? 'Ban address' : 'Ban'}
		</button>
	</form>
</section>

<div class="list-head">
	<div class="segmented" role="group" aria-label="Show">
		{#each FILTERS as f (f.id)}
			<button type="button" aria-pressed={filter === f.id} onclick={() => (filter = f.id)}>
				{f.label}<span class="count">{people.filter(f.test).length}</span>
			</button>
		{/each}
	</div>
	<span class="faint small">
		{data.lists.serverRunning
			? 'Server running, so changes apply live.'
			: 'Server stopped: changes go to the JSON files, names resolve through Mojang.'}
	</span>
</div>

{#if shown.length === 0}
	<div class="empty">
		<p>
			{filter === 'all'
				? 'Nobody yet. Whitelist or op someone above; players who join show up here too.'
				: 'Nobody in this list.'}
		</p>
	</div>
{:else}
	<div class="table-box">
		<table>
			<thead>
				<tr>
					<th>Player</th>
					<th>Status</th>
					<th><span class="visually-hidden">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				{#each shown as person (person.key)}
					<tr>
						<td>
							<div class="who">
								<span class="avatar" style="--hue: {avatarTone(person.name)}" aria-hidden="true"></span>
								<div class="who-text">
									<div class="who-name">
										{person.name}
										{#if person.whitelisted}<span class="tag">whitelisted</span>{/if}
										{#if person.op}<span class="tag accent">op {person.op.level ?? ''}</span>{/if}
									</div>
									<div class="faint small mono">
										{#if person.file}last saved {formatRelative(person.file.modifiedAt)}{:else}never joined{/if}{person.uuid
											? ` · ${person.uuid}`
											: ''}
									</div>
									{#if person.ban?.reason}
										<div class="small ban-reason">Banned: {person.ban.reason}</div>
									{/if}
								</div>
							</div>
						</td>
						<td class="nowrap">
							{#if person.ban}
								<span class="status" data-tone="failed"><span class="dot failed"></span>Banned</span>
							{:else if person.online}
								<span class="status" data-tone="running"><span class="dot running"></span>Online</span>
							{:else}
								<span class="status"><span class="dot"></span>Offline</span>
							{/if}
						</td>
						<td class="right nowrap">
							{#if person.file}
								<a class="button button-quiet" href={playerUrl(person.file.uuid)}>Inventory</a>
							{/if}
							<details class="more">
								<summary class="button button-quiet">More ▾</summary>
								<div class="menu">
									<form method="POST" use:enhance>
										<input type="hidden" name="name" value={person.name} />
										{#if !person.whitelisted}
											<button formaction="?/add" name="list" value="whitelist">Add to whitelist</button>
										{/if}
										{#if !person.op}
											<button formaction="?/add" name="list" value="ops">Make operator</button>
										{/if}
										{#if person.online}
											<input type="hidden" name="reason" value={newReason || 'Kicked by an operator'} />
											<button formaction="?/kick" title="Uses the reason typed above, if any">Kick</button>
										{/if}
									</form>
									{#if person.whitelisted}
										<form method="POST" action="?/remove" use:enhance>
											<input type="hidden" name="name" value={person.whitelisted} />
											<button name="list" value="whitelist">Remove from whitelist</button>
										</form>
									{/if}
									{#if person.op}
										<form method="POST" action="?/remove" use:enhance>
											<input type="hidden" name="name" value={person.op.key} />
											<button name="list" value="ops">Remove operator</button>
										</form>
									{/if}
									{#if person.op && !data.lists.serverRunning}
										<form method="POST" action="?/opOptions" use:enhance={keepValues} class="op-options">
											<input type="hidden" name="name" value={person.op.key} />
											<select name="level" class="level" aria-label="Level of {person.name}">
												{#each [4, 3, 2, 1] as level (level)}
													<option value={level} selected={person.op.level === level}>op {level}</option>
												{/each}
											</select>
											<label class="check">
												<input name="bypass" type="checkbox" checked={person.op.bypassesPlayerLimit} />
												Bypasses limit
											</label>
											<button class="button-quiet">Save</button>
										</form>
									{/if}
									<form method="POST" use:enhance>
										<input type="hidden" name="name" value={person.ban?.key ?? person.name} />
										{#if person.ban}
											<button class="danger" formaction="?/remove" name="list" value="bans">Pardon</button>
										{:else}
											<input type="hidden" name="reason" value={newReason} />
											<button class="danger" formaction="?/add" name="list" value="bans">Ban</button>
											{#if person.online}
												<button
													class="danger"
													formaction="?/add"
													name="list"
													value="ipBans"
													title="Bans the address {person.name} is connected from">Ban IP</button
												>
											{/if}
										{/if}
									</form>
								</div>
							</details>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

{#if data.lists.ops.length && data.lists.serverRunning}
	<p class="faint small after">
		While the server runs, new operators get level {data.lists.defaultOpLevel} (op-permission-level); stop it to pick or
		change levels.
	</p>
{/if}

<details class="extra" open={data.lists.ipBans.length > 0}>
	<summary>IP bans ({data.lists.ipBans.length})</summary>
	{#if data.lists.ipBans.length === 0}
		<p class="faint small">
			No addresses are banned. Type an address in the field above and press Ban, or use Ban IP on an online player.
		</p>
	{:else}
		<div class="table-box">
			<table>
				<thead><tr><th>Address</th><th>Reason</th><th>Banned</th><th>By</th><th></th></tr></thead>
				<tbody>
					{#each data.lists.ipBans as entry (entry.key)}
						<tr>
							<td class="mono">{entry.name}</td>
							<td>{entry.reason ?? ''}</td>
							<td class="small muted nowrap">{entry.created?.slice(0, 16) ?? ''}</td>
							<td class="small muted">{entry.source ?? ''}</td>
							<td class="right">
								<form method="POST" action="?/remove" use:enhance>
									<input type="hidden" name="list" value="ipBans" />
									<input type="hidden" name="name" value={entry.key} />
									<button class="button-quiet">Pardon</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</details>

{#if unnamedFiles.length}
	<details class="extra">
		<summary>Player data with no known name ({unnamedFiles.length})</summary>
		<ul class="files">
			{#each unnamedFiles as file (file.uuid)}
				<li>
					<a class="mono small" href={playerUrl(file.uuid)}>{file.uuid}</a>
					<span class="faint small">last saved {formatRelative(file.modifiedAt)}</span>
				</li>
			{/each}
		</ul>
	</details>
{/if}

<style>
	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		flex-wrap: wrap;
		padding: 1rem 1.25rem;
		margin-bottom: 1.25rem;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
	}

	.enforce {
		display: flex;
		align-items: center;
		gap: 0.9rem;
	}

	.enforce span {
		display: flex;
		flex-direction: column;
	}

	.add {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.add input {
		width: 12.5rem;
	}

	.level {
		width: auto;
	}

	/* A toggle switch: the form posts the opposite of the current state. */
	.switch {
		position: relative;
		width: 40px;
		height: 22px;
		flex: none;
		padding: 0;
		border: 0;
		border-radius: 11px;
		background: var(--line-strong);
	}

	.switch::after {
		content: '';
		position: absolute;
		top: 3px;
		left: 3px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--text);
		transition: left 0.12s;
	}

	.switch[aria-checked='true'] {
		background: var(--accent);
	}

	.switch[aria-checked='true']::after {
		left: 21px;
	}

	.list-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}

	.segmented {
		display: flex;
		flex-wrap: wrap;
		gap: 2px;
		padding: 3px;
		background: var(--bg-sunken);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-lg);
	}

	.segmented button {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		border: 0;
		padding: 0.3rem 0.75rem;
		font-weight: 400;
		background: transparent;
		color: var(--text-muted);
	}

	.segmented button[aria-pressed='true'] {
		background: var(--panel-raised);
		color: var(--text);
	}

	.who {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.avatar {
		width: 26px;
		height: 26px;
		flex: none;
		border-radius: 3px;
		background: var(--hue);
	}

	.who-name {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.ban-reason {
		color: var(--error);
	}

	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.88rem;
		color: var(--text-faint);
	}

	.status[data-tone='running'] {
		color: var(--accent-hover);
	}

	.status[data-tone='failed'] {
		color: var(--error);
	}

	.right {
		text-align: right;
	}

	td .button,
	td button {
		font-size: 0.85rem;
		padding: 0.25rem 0.5rem;
	}

	.more {
		display: inline-block;
		position: relative;
		text-align: left;
	}

	.more summary {
		list-style: none;
	}

	.more summary::-webkit-details-marker {
		display: none;
	}

	.more .menu {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		z-index: 10;
		min-width: 13rem;
		padding: 5px;
		background: var(--panel-raised);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-lg);
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.menu form {
		display: flex;
		flex-direction: column;
	}

	.menu form + form {
		border-top: 1px solid var(--line-strong);
		padding-top: 2px;
	}

	.menu button {
		justify-content: flex-start;
		width: 100%;
		border: 0;
		background: none;
		font-weight: 400;
	}

	.menu button:hover:not(:disabled) {
		background: color-mix(in srgb, var(--text) 8%, transparent);
	}

	.menu .danger {
		color: var(--error);
	}

	.op-options {
		flex-direction: row !important;
		align-items: center;
		gap: var(--space-2);
		padding: 0.25rem 0.4rem;
	}

	.op-options .check {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		margin: 0;
		white-space: nowrap;
	}

	.op-options button {
		width: auto;
	}

	.after {
		margin: var(--space-3) 0 0;
	}

	.extra {
		margin-top: var(--space-5);
	}

	.extra summary {
		cursor: pointer;
		color: var(--text-muted);
		margin-bottom: var(--space-3);
	}

	.files {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: var(--space-1);
	}

	.files li {
		display: flex;
		gap: var(--space-3);
	}
</style>
