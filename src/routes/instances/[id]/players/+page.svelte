<script lang="ts">
	import { can, type InstancePermission } from '#lib/shared/access.js';
	import { tick } from 'svelte';
	import { enhance } from '#lib/shared/forms.js';
	import Flash from '#lib/components/Flash.svelte';
	import PlayerFace from '#lib/components/PlayerFace.svelte';
	import Leaderboard from '#lib/components/Leaderboard.svelte';
	import { formatDuration, formatRelative } from '#lib/shared/format.js';
	import { streamed } from '#lib/shared/streamed.svelte.js';

	let { data, form } = $props();
	/** What this account may do here; the server checks every action again. */
	const may = (permission: InstancePermission) => can(data.access, data.instance.id, permission);

	const keepValues = () => async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) =>
		update({ reset: false });

	let newName = $state('');
	let newReason = $state('');
	let kickReason = $state('');
	let playerQuery = $state('');
	let panelMode = $state<'add' | 'manage' | null>(null);
	let accessType = $state<'whitelist' | 'ops' | 'bans' | 'ipBans'>('whitelist');
	let selectedPersonKey = $state<string | null>(null);
	let hideActionNotice = $state(false);
	let drawerEl = $state<HTMLElement | null>(null);
	let panelOpener: HTMLElement | null = null;
	$effect(() => {
		form;
		hideActionNotice = false;
	});
	/** Avoid treating a typed numeric address as a player name in the add panel. */
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
		file: { uuid: string; modifiedAt: number; fromMojang: boolean } | null;
	};
	// Mojang's profiles (skins, and names for files the server has none for), once they arrive.
	const lookedUp = streamed(() => data.profiles);
	const profiles = $derived((lookedUp.ready ? lookedUp.value : {}) as Record<string, { name: string; skin: string | null }>);
	const playerFiles = $derived(
		data.playerFiles.map((f) => {
			const name = f.name ? null : profiles[f.uuid]?.name;
			return name ? { ...f, name, nameFrom: 'mojang' as const } : f;
		})
	);
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
		for (const f of playerFiles) {
			if (!f.name) continue;
			get(f.name, f.uuid).file = { uuid: f.uuid, modifiedAt: f.modifiedAt, fromMojang: f.nameFrom === 'mojang' };
		}
		return [...byName.values()].sort(
			(a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)
		);
	});
	const selectedPerson = $derived(people.find((p) => p.key === selectedPersonKey) ?? null);
	/** Player data files whose owner's name is not known. */
	const unnamedFiles = $derived(playerFiles.filter((f) => !f.name));

	const FILTERS = [
		{ id: 'all', label: 'All', test: () => true },
		{ id: 'online', label: 'Online', test: (p: Person) => p.online },
		{ id: 'whitelisted', label: 'Whitelisted', test: (p: Person) => p.whitelisted },
		{ id: 'ops', label: 'Operators', test: (p: Person) => !!p.op },
		{ id: 'banned', label: 'Banned', test: (p: Person) => !!p.ban }
	] as const;
	let filter = $state<(typeof FILTERS)[number]['id']>('all');
	const shown = $derived(
		people
			.filter(FILTERS.find((f) => f.id === filter)!.test)
			.filter((p) => !playerQuery.trim() || p.name.toLocaleLowerCase().includes(playerQuery.trim().toLocaleLowerCase()))
	);
	const playerUrl = (uuid: string) => `/instances/${encodeURIComponent(data.instance.id)}/players/${uuid}`;
	const board = streamed(() => data.leaderboard);
	/** For the leaderboard: a listed player by UUID. */
	const boardPlayer = (uuid: string) => ({
		name: people.find((p) => p.uuid?.toLowerCase() === uuid)?.name ?? playerFiles.find((f) => f.uuid === uuid)?.name ?? profiles[uuid]?.name ?? null,
		skin: profiles[uuid]?.skin ?? null,
		href: can(data.access, data.instance.id, 'players.data.view', uuid) ? playerUrl(uuid) : null
	});
	function focusDrawer() {
		void tick().then(() => drawerEl?.querySelector<HTMLElement>('button, input:not([type="hidden"]), select, textarea')?.focus());
	}
	function openAdd(event: MouseEvent) {
		panelOpener = event.currentTarget as HTMLElement;
		hideActionNotice = true;
		selectedPersonKey = null;
		accessType = 'whitelist';
		newName = '';
		newReason = '';
		panelMode = 'add';
		focusDrawer();
	}
	function openManage(person: Person, event: MouseEvent) {
		panelOpener = event.currentTarget as HTMLElement;
		hideActionNotice = true;
		selectedPersonKey = person.key;
		newReason = '';
		kickReason = '';
		panelMode = 'manage';
		focusDrawer();
	}
	function closePanel() {
		panelMode = null;
		selectedPersonKey = null;
		const opener = panelOpener;
		panelOpener = null;
		void tick().then(() => opener?.focus());
	}
	function trapDrawerFocus(event: KeyboardEvent) {
		if (event.key !== 'Tab' || !drawerEl) return;
		const focusable = [...drawerEl.querySelectorAll<HTMLElement>(
			'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
		)].filter((el) => el.getAttribute('aria-hidden') !== 'true' && el.offsetParent !== null);
		if (!focusable.length) {
			event.preventDefault();
			drawerEl.focus();
			return;
		}
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (event.shiftKey && (document.activeElement === first || !drawerEl.contains(document.activeElement))) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (document.activeElement === last || !drawerEl.contains(document.activeElement))) {
			event.preventDefault();
			first.focus();
		}
	}

</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && closePanel()} />

<section class="bar">
	<form method="POST" action="?/whitelist" use:enhance class="enforce">
		<input type="hidden" name="enabled" value={String(!data.lists.whitelistEnforced)} />
		<button
			type="submit"
			class="switch hit-area"
			role="switch"
			aria-checked={data.lists.whitelistEnforced}
			aria-label="Whitelist"
			disabled={!may('players.manage')}
		></button>
		<span>
			<strong>Whitelist {data.lists.whitelistEnforced ? 'on' : 'off'}</strong>
			<span class="muted small">
				{data.lists.whitelistEnforced ? 'Only whitelisted players can join.' : 'Anyone who can reach the port can join.'}
			</span>
		</span>
	</form>

	{#if may('players.manage')}<button type="button" class="button button-primary" onclick={openAdd}>Add access</button>{/if}
</section>

{#if !panelMode && !hideActionNotice}<Flash {form} />{/if}

{#if panelMode}
	<button class="drawer-backdrop" type="button" aria-label="Close player panel" onclick={closePanel}></button>
	<div class="access-drawer" bind:this={drawerEl} role="dialog" aria-modal="true" aria-labelledby="access-title" tabindex="-1" onkeydown={trapDrawerFocus}>
		<header class="drawer-head">
			<div>
				<p class="eyebrow">{panelMode === 'add' ? 'Player access' : 'Access and actions'}</p>
				<h2 id="access-title">{panelMode === 'add' ? 'Add access' : selectedPerson?.name}</h2>
			</div>
			<button type="button" class="button-quiet" onclick={closePanel} aria-label="Close">Close</button>
		</header>
		{#if !hideActionNotice}<Flash {form} />{/if}
		{#if panelMode === 'add'}
			<p class="muted">Choose what this player should be allowed to do. Each access type can be changed separately later.</p>
			<div class="access-types" role="group" aria-label="Access type">
				{#each [
					{ id: 'whitelist', label: 'Whitelist' },
					{ id: 'ops', label: 'Operator' },
					{ id: 'bans', label: 'Ban player' },
					{ id: 'ipBans', label: 'Ban IP' }
				] as option (option.id)}
					<button type="button" aria-pressed={accessType === option.id} onclick={() => (accessType = option.id as typeof accessType)}>{option.label}</button>
				{/each}
			</div>
			<form method="POST" action="?/add" use:enhance={keepValues} class="drawer-form">
				<label for="access-name">
					{accessType === 'ipBans'
						? data.lists.serverRunning ? 'IP address or online player' : 'IP address'
						: 'Minecraft player name'}
				</label>
				<input id="access-name" name="name" bind:value={newName} autocomplete="off" placeholder={accessType === 'ipBans' ? 'e.g. 203.0.113.10' : 'e.g. PlayerName'} required />
				<input type="hidden" name="list" value={accessType} />
				{#if accessType === 'ipBans'}<p class="hint">{data.lists.serverRunning ? 'While the server is running, you can also enter the name of an online player.' : 'When stopped, enter a numeric IP address.'}</p>{/if}
				{#if accessType === 'ops' && !data.lists.serverRunning}
					<label for="new-op-level">Operator level</label>
					<select id="new-op-level" name="level" class="level">
						{#each [4, 3, 2, 1] as level (level)}<option value={level}>op {level}</option>{/each}
					</select>
				{:else if accessType === 'ops'}
					<p class="hint">The server is running. This uses its default operator level ({data.lists.defaultOpLevel}).</p>
				{/if}
				{#if accessType === 'bans' || accessType === 'ipBans'}
					<label for="new-ban-reason">Reason (optional)</label>
					<input id="new-ban-reason" name="reason" bind:value={newReason} maxlength="200" />
				{/if}
				{#if isAddress && accessType !== 'ipBans'}<p class="hint warn-text">This looks like an address. Choose Ban IP to ban an address.</p>{/if}
				<button class:button-danger={accessType === 'bans' || accessType === 'ipBans'} class:button-primary={accessType === 'whitelist'} disabled={isAddress && accessType !== 'ipBans'}>
					{accessType === 'whitelist' ? 'Add to whitelist' : accessType === 'ops' ? 'Make operator' : accessType === 'ipBans' ? 'Ban IP address' : 'Ban player'}
				</button>
			</form>
		{:else if selectedPerson}
			<div class="current-access">
				<span class="tag">{selectedPerson.online ? 'Online' : 'Offline'}</span>
				{#if selectedPerson.whitelisted}<span class="tag">Whitelisted</span>{/if}
				{#if selectedPerson.op}<span class="tag accent">Operator{selectedPerson.op.level ? ` · level ${selectedPerson.op.level}` : ''}</span>{/if}
				{#if selectedPerson.ban}<span class="tag warn">Banned</span>{/if}
			</div>
			<section class="drawer-section">
				<h3>Access</h3>
				<div class="drawer-actions">
					{#if selectedPerson.whitelisted}
						<form method="POST" action="?/remove" use:enhance><input type="hidden" name="name" value={selectedPerson.whitelisted} /><input type="hidden" name="list" value="whitelist" /><button class="button-quiet">Remove from whitelist</button></form>
					{:else}
						<form method="POST" action="?/add" use:enhance><input type="hidden" name="name" value={selectedPerson.name} /><input type="hidden" name="list" value="whitelist" /><button class="button-primary">Add to whitelist</button></form>
					{/if}
					{#if selectedPerson.op}
						<span class="tag accent">Operator{selectedPerson.op.level ? ` · level ${selectedPerson.op.level}` : ''}</span>
					{:else if may('console.command')}
						<form method="POST" action="?/add" use:enhance><input type="hidden" name="name" value={selectedPerson.name} /><input type="hidden" name="list" value="ops" />{#if !data.lists.serverRunning}<input type="hidden" name="level" value="4" />{/if}<button>Make operator</button></form>
					{/if}
				</div>
				<!-- An operator runs commands in the game: managing them is console access too. -->
				{#if selectedPerson.op && may('console.command')}
					<div class="operator-settings">
						<div class="operator-heading">
							<div><strong>Operator settings</strong><p class="small muted">Permission level and player limit access.</p></div>
							<form method="POST" action="?/remove" use:enhance><input type="hidden" name="name" value={selectedPerson.op.key} /><input type="hidden" name="list" value="ops" /><button class="button-quiet">Remove operator</button></form>
						</div>
						{#if !data.lists.serverRunning}
							<form method="POST" action="?/opOptions" use:enhance={keepValues} class="operator-form">
								<input type="hidden" name="name" value={selectedPerson.op.key} />
								<label class="operator-level">Operator level
									<select name="level" class="level">
										{#each [4, 3, 2, 1] as level (level)}<option value={level} selected={selectedPerson.op.level === level}>Level {level}</option>{/each}
									</select>
								</label>
								<label class="operator-check"><input name="bypass" type="checkbox" class="switch" role="switch" checked={selectedPerson.op.bypassesPlayerLimit} /> Bypasses the player limit</label>
								<button class="button-quiet">Save settings</button>
							</form>
						{:else}
							<p class="hint">These settings can be changed while the server is stopped.</p>
						{/if}
					</div>
				{/if}
			</section>
			<section class="drawer-section">
				<h3>Moderation</h3>
				{#if selectedPerson.online}
					<form method="POST" action="?/kick" use:enhance class="drawer-form">
						<input type="hidden" name="name" value={selectedPerson.name} />
						<label for="kick-reason">Kick reason (optional)</label><input id="kick-reason" name="reason" bind:value={kickReason} maxlength="200" />
						<button class="button-quiet">Kick player</button>
					</form>
				{/if}
				{#if selectedPerson.ban}
					<p>{selectedPerson.ban.reason ? `Reason: ${selectedPerson.ban.reason}` : 'This player is banned.'}</p>
					<form method="POST" action="?/remove" use:enhance><input type="hidden" name="name" value={selectedPerson.ban.key} /><input type="hidden" name="list" value="bans" /><button class="button-quiet">Pardon player</button></form>
				{:else}
					<form method="POST" action="?/add" use:enhance class="drawer-form">
						<input type="hidden" name="name" value={selectedPerson.name} /><input type="hidden" name="list" value="bans" />
						<label for="manage-ban-reason">Ban reason (optional)</label><input id="manage-ban-reason" name="reason" bind:value={newReason} maxlength="200" />
						<button class="button-danger">Ban player</button>
					</form>
					{#if selectedPerson.online}<form method="POST" action="?/add" use:enhance class="drawer-form"><input type="hidden" name="name" value={selectedPerson.name} /><input type="hidden" name="list" value="ipBans" /><button class="button-danger">Ban this player’s IP address</button></form>{/if}
				{/if}
			</section>
		{/if}
	</div>
{/if}

<div class="list-head">
	<div class="segmented" role="group" aria-label="Show">
		{#each FILTERS as f (f.id)}
			<button type="button" aria-pressed={filter === f.id} onclick={() => (filter = f.id)}>
				{f.label}<span class="count">{people.filter(f.test).length}</span>
			</button>
		{/each}
	</div>
	<label class="player-search"><span class="visually-hidden">Search players</span><input type="search" bind:value={playerQuery} placeholder="Search players" /></label>
	<span class="faint small">
		{data.lists.serverRunning
			? 'Server running, so changes apply live.'
			: 'Server stopped: changes go to the JSON files, names resolve through Mojang.'}
	</span>
</div>

{#if shown.length === 0}
	<div class="empty">
		<p>
			{playerQuery.trim()
				? 'No players match that search.'
				: filter === 'all'
				? 'Nobody yet. Whitelist or op someone above; players who join show up here too.'
				: 'Nobody in this list.'}
		</p>
		{#if playerQuery.trim()}<button type="button" class="button-quiet" onclick={() => (playerQuery = '')}>Clear search</button>{/if}
	</div>
{:else}
	<div class="table-box">
		<table class="people">
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
								<PlayerFace id={person.uuid ?? person.name} skin={person.uuid ? (profiles[person.uuid.toLowerCase()]?.skin ?? null) : null} />
								<div class="who-text">
									<div class="who-name">
										{person.name}
										{#if person.whitelisted}<span class="tag">whitelisted</span>{/if}
										{#if person.op}<span class="tag accent">op {person.op.level ?? ''}</span>{/if}
									</div>
									{#if data.playtimes[person.name]}
										{@const p = data.playtimes[person.name]}
										<div class="faint small">
											played {formatDuration(p.totalMs)} · {p.online ? 'online now' : `last seen ${formatRelative(p.lastSeen)}`}
										</div>
									{/if}
									<div class="faint small mono">
										{#if person.file}last saved {formatRelative(person.file.modifiedAt)}{:else}never joined{/if}
									</div>
									{#if person.uuid}<div class="faint small mono uuid">{#each person.uuid.split('-') as part, i}{#if i}-<wbr />{/if}{part}{/each}</div>{/if}
									{#if person.file?.fromMojang}
										<div class="faint small" title="This server's files do not name this player; Mojang gave the account's current name.">
											name from Mojang
										</div>
									{/if}
									{#if person.ban?.reason}
										<div class="small ban-reason">Banned: {person.ban.reason}</div>
									{/if}
								</div>
							</div>
						</td>
						<td class="nowrap person-status">
							{#if person.ban}
								<span class="status" data-tone="failed"><span class="dot failed"></span>Banned</span>
							{:else if person.online}
								<span class="status" data-tone="running"><span class="dot running"></span>Online</span>
							{:else}
								<span class="status"><span class="dot"></span>Offline</span>
							{/if}
						</td>
						<td class="right nowrap person-actions">
							{#if person.file && can(data.access, data.instance.id, 'players.data.view', person.file.uuid)}
								<a class="button button-quiet" href="{playerUrl(person.file.uuid)}?view=stats">Stats</a>
								<a class="button button-quiet" href={playerUrl(person.file.uuid)}>Inventory</a>
							{/if}
							{#if may('players.manage')}
								<button type="button" class="button-quiet" onclick={(event) => openManage(person, event)}>Manage</button>
							{/if}
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

<details class="extra" open>
	<summary>Leaderboard</summary>
	<Leaderboard board={board.value ?? null} loading={!board.ready} player={boardPlayer} />
</details>

{#if may('players.manage')}
<details class="extra" open={data.lists.ipBans.length > 0}>
	<summary>IP bans ({data.lists.ipBans.length})</summary>
	{#if data.lists.ipBans.length === 0}
		<p class="faint small">
			No addresses are banned. Use Add access to enter an address, or open an online player and choose Ban IP.
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
{/if}

{#if unnamedFiles.length}
	<details class="extra">
		<summary>Player data with no known name ({unnamedFiles.length})</summary>
		<ul class="files">
			{#each unnamedFiles as file (file.uuid)}
				<li>
					<a class="mono small" href={playerUrl(file.uuid)}>{file.uuid}</a>
					<span class="faint small">
						last saved {formatRelative(file.modifiedAt)}{#if file.offline}
							· offline-mode player: the name cannot be looked up{:else if !lookedUp.ready}
							· asking Mojang for the name{/if}
					</span>
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

	.level {
		width: auto;
	}

	/* A toggle switch: the form posts the opposite of the current state. */
	.list-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}

	.player-search { flex: 1 1 13rem; max-width: 20rem; }
	.player-search input { width: 100%; }

	.drawer-backdrop {
		position: fixed;
		inset: 0;
		z-index: 39;
		width: 100%;
		border: 0;
		border-radius: 0;
		background: rgba(0, 0, 0, 0.48);
	}

	.access-drawer {
		position: fixed;
		inset: 0 0 0 auto;
		z-index: 40;
		width: min(28rem, 100vw);
		height: 100dvh;
		overflow-y: auto;
		padding: 1.25rem;
		background: var(--panel);
		border-left: 1px solid var(--line-strong);
		box-shadow: -12px 0 32px rgba(0, 0, 0, 0.28);
	}

	.drawer-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); margin-bottom: var(--space-3); }
	.drawer-head h2 { margin: 0; font-size: 1.2rem; }
	.eyebrow { margin: 0 0 0.2rem; color: var(--text-faint); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; }
	.access-drawer > p { margin: 0 0 var(--space-4); }
	.access-types { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); margin-bottom: var(--space-4); }
	.access-types button[aria-pressed='true'] { border-color: var(--accent); color: var(--text); background: color-mix(in srgb, var(--accent) 12%, var(--panel)); }
	.drawer-form { display: grid; gap: var(--space-2); margin-top: var(--space-3); }
	.drawer-form label { margin: 0; }
	.drawer-form input:not([type='checkbox']), .drawer-form select { width: 100%; }
	.drawer-form button { justify-self: start; }
	.current-access { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: var(--space-3) 0; }
	.drawer-section { padding: var(--space-3) 0; border-top: 1px solid var(--line); }
	.drawer-section h3 { margin: 0 0 var(--space-2); font-size: 0.92rem; }
	.drawer-actions { display: flex; align-items: flex-start; flex-wrap: wrap; gap: var(--space-2); }
	.drawer-actions form { margin: 0; }
	.drawer-section p { color: var(--text-muted); }
	.operator-settings { margin-top: var(--space-3); padding: var(--space-3); background: var(--bg-sunken); border: 1px solid var(--line); border-radius: var(--radius); }
	.operator-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-2); }
	.operator-heading p { margin: 0.2rem 0 0; }
	.operator-form { display: grid; gap: var(--space-2); margin-top: var(--space-3); }
	.operator-level { display: grid; gap: var(--space-1); max-width: 13rem; }
	.operator-form select { width: 100%; }
	.operator-check { display: flex; align-items: center; gap: var(--space-2); font-weight: 400; }
	.operator-form button { justify-self: start; }
	.operator-settings > .hint { margin-bottom: 0; }

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

	.who-name {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.who-text {
		flex: 1 1 0;
		min-width: 0;
	}

	/* Break only after a hyphen (<wbr> in the markup: browsers refuse a break
	   between a hyphen and a digit), as late as the line allows. */
	.uuid {
		overflow-wrap: normal;
		word-break: normal;
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

	@media (max-width: 600px) {
		.access-drawer { width: 100vw; padding: 1rem; border-left: 0; }
	}

	/* Phones: one card per player instead of a three-column table. */
	@media (max-width: 40rem) {
		.table-box:has(> .people) {
			overflow: visible;
			background: transparent;
			border: 0;
		}

		:global(.content table.people),
		.people tbody {
			display: block;
			width: 100%;
		}

		.people thead {
			display: none;
		}

		.people tr {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: center;
			gap: var(--space-2) var(--space-3);
			margin-bottom: var(--space-3);
			padding: var(--space-3);
			background: var(--panel);
			border: 1px solid var(--line);
			border-radius: var(--radius-lg);
		}

		.people td {
			display: block;
			padding: 0;
			border: 0;
			background: transparent;
		}

		.people td:first-child {
			grid-column: 1 / -1;
			grid-row: 1;
		}

		.people .person-status {
			grid-column: 1;
			grid-row: 2;
		}

		.people .person-actions {
			grid-column: 2;
			grid-row: 2;
			display: flex;
			flex-wrap: wrap;
			justify-content: flex-end;
			gap: var(--space-2);
		}
	}
</style>
