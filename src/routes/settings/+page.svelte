<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import PathText from '#lib/components/PathText.svelte';
	import { page } from '$app/state';
	import Flash from '#lib/components/Flash.svelte';
	import SnapshotPolicyFields from '#lib/components/SnapshotPolicyFields.svelte';
	import { formatBytes, formatDateTime } from '#lib/shared/format.js';
	import { streamed } from '#lib/shared/streamed.svelte.js';
	import { invalidateAll } from '$app/navigation';
	import { browser } from '$app/env';
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';

	let { data, form } = $props();

	const tab = $derived(page.url.searchParams.get('tab') ?? 'system');
	let showUnit = $state(false);
	let manualJava = $state('');
	// Re-synced after a save; see the bind/$effect note in CLAUDE.md.
	// svelte-ignore state_referenced_locally
	let snap = $state({ ...data.snapshots });
	$effect(() => {
		snap = { ...data.snapshots };
	});

	const playitInfo = streamed(() => data.playit.status);
	const playit = $derived(playitInfo.ready ? playitInfo.value : null);
	const locationsInfo = streamed(() => data.playit.locations);
	const locations = $derived(locationsInfo.ready ? (locationsInfo.value ?? []) : []);
	// While a link waits for its approval on playit.gg, look again every 2 s.
	const claiming = $derived(!!data.playit.claim && ['waiting', 'visited', 'finishing'].includes(data.playit.claim.state));
	$effect(() => {
		if (!claiming) return;
		const timer = setInterval(() => void invalidateAll(), 2000);
		return () => clearInterval(timer);
	});
	// svelte-ignore state_referenced_locally
	let itemIcons = $state(data.itemIcons);
	$effect(() => {
		itemIcons = data.itemIcons;
	});

	// Updates. Re-synced after a save, like the snapshot fields.
	// svelte-ignore state_referenced_locally
	let autoCheck = $state(data.update.autoCheck);
	$effect(() => {
		autoCheck = data.update.autoCheck;
	});
	const updateTask = $derived((form as { updateTask?: string } | null)?.updateTask ?? null);
	const updateRun = $derived(data.update.run);
	const releaseNotes = $derived.by(() => {
		const notes = data.update.available?.notes;
		if (!browser || !notes) return '';
		return DOMPurify.sanitize(marked.parse(notes, { async: false }) as string);
	});
	let updateSlow = $state(false);
	// The installer restarts MineShell: ask until the server answers with another
	// version (or says the update failed), then load the page afresh from the new one.
	$effect(() => {
		if (!updateTask && updateRun?.outcome !== 'running') return;
		const from = data.update.current;
		const started = Date.now();
		updateSlow = false;
		const timer = setInterval(async () => {
			if (Date.now() - started > 5 * 60_000) updateSlow = true;
			try {
				const res = await fetch('/api/update');
				if (!res.ok) return;
				const state = (await res.json()) as { current: string; run: { outcome: string } | null };
				if (state.current !== from || state.run?.outcome === 'failed') {
					clearInterval(timer);
					location.assign('/settings?tab=updates');
				}
			} catch {
				/* restarting */
			}
		}, 2000);
		return () => clearInterval(timer);
	});

	const CLAIM_TEXT: Record<string, string> = {
		waiting: 'Waiting for you to open the link.',
		visited: 'Waiting for you to approve it on playit.gg.',
		finishing: 'Approved. Downloading and starting the agent...',
		linked: 'Linked.',
		rejected: 'Not approved on playit.gg.',
		expired: 'The link expired (10 minutes); start again.',
		failed: 'Linking failed.'
	};
</script>

<svelte:head><title>MineShell settings - MineShell</title></svelte:head>

<Flash {form} />

<div class="app-settings">

{#if tab === 'java'}
<section class="panel">
	<div class="panel-head">
		<div>
			<h2>Java runtimes</h2>
			<p>
				Each server picks a runtime matching its Minecraft version, unless one is pinned in that
				server's settings. With several of one version, it takes the one set here, or else the newest.
			</p>
		</div>
		<form method="POST" action="?/scanJava" use:enhance>
			<button type="submit">Scan again</button>
		</form>
	</div>

	{#if data.javaRuntimes.length === 0}
		<div class="empty">
			<p>
				No Java found. On Debian and Ubuntu, <code>sudo apt install openjdk-21-jre-headless</code>
				covers Minecraft 1.20.5 and newer; older versions need 17 or 8.
			</p>
		</div>
	{:else}
		<table class="stacked java-table">
			<thead>
				<tr>
					<th>Version</th>
					<th>Path</th>
					<th>Found</th>
					<th>Servers use</th>
					<th><span class="visually-hidden">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.javaRuntimes as java (java.path)}
					<tr>
						<td class="mono">Java {java.majorVersion}</td>
						<td class="mono small"><PathText path={java.path} /></td>
						<td class="small faint">
							{java.managed ? 'downloaded' : java.manual ? 'added by hand' : 'scanned'}
							{#if java.vendor}<div class="small">{java.vendor}</div>{/if}
						</td>
						<td class="small">
							{#if java.inUse}
								<span class="tag accent">Java {java.majorVersion}{java.isDefault ? ', default' : ''}</span>
							{/if}
							{#if java.siblings > 1}
								<form method="POST" action="?/javaDefault" use:enhance class="default-form">
									<input type="hidden" name="major" value={java.majorVersion} />
									{#if java.isDefault}
										<input type="hidden" name="path" value="" />
										<button class="button-quiet" title="Use the newest Java {java.majorVersion} instead">Use newest</button>
									{:else if !java.inUse}
										<input type="hidden" name="path" value={java.path} />
										<button class="button-quiet">Use for Java {java.majorVersion}</button>
									{/if}
								</form>
							{/if}
						</td>
						<td class="right">
							{#if java.managed}
								<!-- A rescan finds it again, so forgetting alone would not stick. -->
								<form
									method="POST"
									action="?/deleteJava"
									use:enhance={({ cancel }) => {
										if (!confirm(`Delete Java ${java.majorVersion} from disk?`)) cancel();
									}}
								>
									<input type="hidden" name="path" value={java.path} />
									<button class="button-quiet">Delete</button>
								</form>
							{:else}
								<form method="POST" action="?/removeJava" use:enhance>
									<input type="hidden" name="path" value={java.path} />
									<button class="button-quiet">Forget</button>
								</form>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	<form method="POST" action="?/addJava" use:enhance class="inline-form">
		<div class="field grow">
			<label for="java-path">Add a runtime by path</label>
			<input id="java-path" name="path" class="mono" bind:value={manualJava} placeholder="/opt/jdk-21/bin/java" />
		</div>
		<button type="submit">Add</button>
	</form>

	<h3 class="java-download">Download a runtime</h3>
	{#if data.javaDownloads.missing.length}
		<div class="notice warning">
			<p>
				No matching Java for:
				{data.javaDownloads.missing.map((m) => `${m.name} (Java ${m.major})`).join(', ')}.
			</p>
		</div>
	{/if}
	<form method="POST" action="?/downloadJava" use:enhance class="inline-form">
		<div class="field">
			<label for="java-vendor">From</label>
			<select id="java-vendor" name="vendor">
				{#each data.javaDownloads.vendors as vendor (vendor.id)}
					<option value={vendor.id}>{vendor.label}</option>
				{/each}
			</select>
		</div>
		<div class="field">
			<label for="java-major">Version</label>
			<select id="java-major" name="major">
				{#each data.javaDownloads.majors as major (major)}
					<option value={major} selected={major === (data.javaDownloads.missing[0]?.major ?? 21)}>
						Java {major}{data.javaRuntimes.some((j) => j.majorVersion === major) ? ' (installed)' : ''}
					</option>
				{/each}
			</select>
		</div>
		<button type="submit">Download</button>
	</form>
	<p class="muted small">
		A JRE (the JDK where the vendor has no JRE for that version), checked against the vendor's SHA-256 and
		kept in <code>{data.paths.data}/java</code>. Servers set to match Java automatically pick it up.
	</p>
</section>
{:else if tab === 'snapshots'}
<section class="panel">
	<h2>World snapshots</h2>
	<p class="muted">
		Before a pack version change or reinstall, a loader version change, a Cleanroom migration or revert, or a mod
		update, the world is copied to a snapshot you can restore from the server's World tab; these copies cost time and
		disk space on big worlds. Resetting, replacing, restoring or pruning keeps what it replaces as a snapshot by
		moving it, which costs no extra space. Snapshots of one dimension are partial ones.
	</p>
	<form method="POST" action="?/snapshots" use:enhance={() => async ({ update }) => update({ reset: false })}>
		<SnapshotPolicyFields bind:values={snap} idPrefix="snap" />
		<p class="faint small">
			Each server can set its own in its settings; a blank field there follows these. Old snapshots go when the next one
			is taken. Pinned snapshots are never deleted and not counted.
		</p>
		<button class="button-primary" type="submit">Save</button>
	</form>

	{#if data.snapshotUsage.length}
		<h3 class="usage-heading">Per server</h3>
		<table>
			<thead>
				<tr><th>Server</th><th>Full</th><th>Partial</th><th>Pinned</th><th class="num">Size</th></tr>
			</thead>
			<tbody>
				{#each data.snapshotUsage as row (row.id)}
					<tr>
						<td>
							<a href="/instances/{encodeURIComponent(row.id)}/world">{row.name}</a>
							{#if row.ownSettings}<span class="tag">own settings</span>{/if}
						</td>
						<td class="mono">{row.usage.full}</td>
						<td class="mono">{row.usage.partial}</td>
						<td class="mono">{row.usage.pinned}{row.usage.pinned ? ` (${formatBytes(row.usage.pinnedBytes)})` : ''}</td>
						<td class="num mono">{formatBytes(row.usage.bytes)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if data.freeBytes !== null}
			<p class="faint small">{formatBytes(data.freeBytes)} free on the disk holding the servers.</p>
		{/if}
	{/if}
</section>
{:else if tab === 'integrations'}
<section class="panel">
	<h2>CurseForge API key</h2>
	<p>
		Optional. Without a working key, CurseForge browsing, search, and pack installs all go
		through the public modpacks.ch mirror. With one, search and project pages use CurseForge's
		own API instead - more reliable, and it's the only way to get a real changelog. Installing a
		picked pack still resolves its files through the mirror either way.
	</p>

	{#if data.curseforge.source !== 'none'}
		<div class="notice {data.curseforge.valid ? 'success' : 'warning'}">
			<p>
				{#if data.curseforge.valid}
					Working{data.curseforge.source === 'env' ? ' (from the CURSEFORGE_API_KEY environment variable)' : ''}.
				{:else}
					{data.curseforge.source === 'env'
						? 'The CURSEFORGE_API_KEY environment variable is'
						: 'The saved key is'} not confirmed working - falling back to the public modpacks.ch mirror.
				{/if}
			</p>
		</div>
	{/if}

	<form method="POST" action="?/curseforgeKey" use:enhance class="inline-form">
		<div class="field grow">
			<label for="curseforge-key">
				{data.curseforge.source === 'none' ? 'API key' : 'Replace the key'}
			</label>
			<input
				id="curseforge-key"
				name="apiKey"
				type="password"
				autocomplete="new-password"
				data-1p-ignore
				data-lpignore="true"
				data-bwignore
				data-form-type="other"
				placeholder="Paste a key from console.curseforge.com"
			/>
		</div>
		<button class="button-primary" type="submit">Save &amp; test</button>
	</form>
	<p class="muted small">
		Get one free at <a href="https://console.curseforge.com/" target="_blank" rel="noreferrer">console.curseforge.com</a>
		(sign in, then API keys).
	</p>
	{#if data.curseforge.source === 'saved'}
		<form method="POST" action="?/removeCurseforgeKey" use:enhance class="inline-form">
			<button class="button-quiet" type="submit">Remove saved key</button>
		</form>
	{/if}
</section>
<section class="panel">
	<h2>playit.gg</h2>
	<p>
		Lets players reach a server from outside without port forwarding: playit gives it a public
		address and passes the connections through a small program (the playit agent) that MineShell
		runs next to the servers. Free accounts work; each server is made public in its own
		settings (Network).
	</p>

	{#if !data.playit.linked}
		{#if data.playit.claim && claiming}
			<div class="notice">
				<p>
					Open <a href={data.playit.claim.url} target="_blank" rel="noreferrer">{data.playit.claim.url}</a> while signed in to
					playit.gg and approve it.
				</p>
				<p class="small muted">{CLAIM_TEXT[data.playit.claim.state]}</p>
			</div>
			<form method="POST" action="?/playitCancel" use:enhance class="inline-form">
				<button class="button-quiet" type="submit" disabled={data.playit.claim.state === 'finishing'}>Cancel</button>
			</form>
		{:else}
			{#if data.playit.claim && data.playit.claim.state !== 'linked'}
				<div class="notice warning">
					<p>{CLAIM_TEXT[data.playit.claim.state]}{data.playit.claim.message ? ` ${data.playit.claim.message}` : ''}</p>
				</div>
			{/if}
			<form method="POST" action="?/playitLink" use:enhance class="inline-form">
				<button class="button-primary" type="submit">Link playit.gg</button>
			</form>
			<p class="muted small">
				You approve MineShell on playit.gg; no password or account key passes through MineShell. Needs a
				free account at <a href="https://playit.gg" target="_blank" rel="noreferrer">playit.gg</a>. A free account
				takes one agent: remove old ones under <a href={data.playit.dashboard} target="_blank" rel="noreferrer">Agents on playit.gg</a>
				first.
			</p>
		{/if}
	{:else if !playit}
		<p class="muted small">Asking playit.gg...</p>
	{:else}
		<div class="notice {playit.running && !playit.error && !playit.problem ? 'success' : 'warning'}">
			<p>
				{#if playit.error}
					{playit.error}
				{:else if playit.problem}
					{playit.problem}
				{:else if !playit.running}
					Linked, but the agent is not running (unit <code>{data.playit.unit}</code>); public servers cannot be reached.
				{:else}
					Linked; the agent is running. {playit.premium ? 'playit Premium.' : 'Free plan.'}
				{/if}
			</p>
		</div>
		<p class="small">
			<a href={data.playit.agentPage} target="_blank" rel="noreferrer">This agent on playit.gg</a> ·
			<a href={data.playit.dashboard} target="_blank" rel="noreferrer">All agents</a>
			<span class="muted">(rename, remove, see its tunnels)</span>
		</p>
		<form method="POST" action="?/playitRouting" use:enhance={() => async ({ update }) => update({ reset: false })} class="inline-form">
			<div class="field grow">
				<label for="playit-routing">Connects through</label>
				<select id="playit-routing" name="routing" value={data.playit.routing}>
					<option value="Automatic">Automatic (nearest playit location)</option>
					{#each locations as location (location.pop)}
						<option value={location.pop} disabled={!location.online}>{location.name}{location.online ? '' : ' (offline)'}</option>
					{/each}
				</select>
			</div>
			<button type="submit">Save</button>
		</form>
		<p class="muted small">
			Which playit location this machine's agent connects out through; free on every plan. Where players
			connect (a server's region) is set per server and is Premium.
		</p>
		{#if playit.servers.length}
			<h3>Public servers</h3>
			<ul class="plain-list">
				{#each playit.servers as server (server.id)}
					<li>
						<a href="/instances/{server.id}/settings?tab=network">{server.name}</a>
						<span class="mono">{server.address ?? 'getting an address...'}</span>
						<span class="faint small">to port {server.port}</span>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted small">No server is public yet: switch it on in a server's settings, Network.</p>
		{/if}
		{#if playit.others.length}
			<h3>Other tunnels on this agent</h3>
			<p class="muted small">Made on playit.gg, not by MineShell; they keep working, MineShell leaves them alone.</p>
			<ul class="plain-list">
				{#each playit.others as tunnel (tunnel.id)}
					<li>
						<span>{tunnel.name}</span>
						<span class="mono">{tunnel.address}</span>
						<span class="faint small">
							to port {tunnel.localPort ?? '?'}{tunnel.server ? ` (${tunnel.server})` : ''}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
		<form
			method="POST"
			action="?/playitUnlink"
			use:enhance
			class="inline-form"
			onsubmit={(e) => {
				if (!confirm("Unlink playit.gg? MineShell's tunnels are deleted (their addresses are gone for good) and the agent stops.")) e.preventDefault();
			}}
		>
			<button class="button-danger" type="submit">Unlink</button>
		</form>
		<p class="muted small">The agent stays listed on playit.gg after unlinking; remove it there if you like.</p>
	{/if}
</section>
{:else if tab === 'security'}
{#if data.authEnabled}
	<section class="panel">
		<h2>Admin password</h2>
		<form method="POST" action="?/password" use:enhance>
			<div class="grid-2">
				<div class="field">
					<label for="password">New password</label>
					<input id="password" name="password" type="password" minlength="8" required />
				</div>
				<div class="field">
					<label for="confirm">New password again</label>
					<input id="confirm" name="confirm" type="password" minlength="8" required />
				</div>
			</div>
			<div class="check field">
				<input id="signOutEverywhere" name="signOutEverywhere" type="checkbox" checked />
				<label for="signOutEverywhere">Sign out every other device</label>
			</div>
			<button class="button-primary" type="submit">Change password</button>
		</form>
	</section>
{:else}
	<section class="panel">
		<h2>Authentication</h2>
		<div class="notice warning">
			<p>
				Login is disabled (<code>MINESHELL_AUTH=off</code>). Anyone who can reach this page can
				start, stop and delete your servers, and read every file in an instance.
			</p>
		</div>
	</section>
{/if}
{:else if tab === 'updates'}
{@const u = data.update}
<section class="panel">
	<h2>MineShell version</h2>
	<p>
		Running <strong>{u.current}</strong>{#if !u.installed}
			from a source checkout{/if}.
	</p>

	{#if updateTask || updateRun?.outcome === 'running'}
		<div class="notice info">
			<p>
				Updating to {updateRun?.to ?? u.available?.version}. MineShell restarts on its own; this page loads again when it
				is back. Your servers keep running.
			</p>
			{#if updateSlow}
				<p>
					This is taking long. The installer's log: <code>journalctl --user -u {updateRun?.unit ?? 'mineshell-update-*'}</code>
				</p>
			{/if}
		</div>
	{:else if updateRun?.outcome === 'failed'}
		<div class="notice error">
			<p>The update from {updateRun.from} to {updateRun.to} failed ({formatDateTime(updateRun.finishedAt)}); {u.current} is still running.</p>
			{#if updateRun.log.length}<pre class="update-log">{updateRun.log.join('\n')}</pre>{/if}
		</div>
	{:else if updateRun?.outcome === 'done' && updateRun.to === u.current}
		<p class="small muted">Updated from {updateRun.from} on {formatDateTime(updateRun.finishedAt)}.</p>
	{/if}

	{#if u.available}
		<div class="release">
			<h3>
				{u.available.name}
				<span class="small muted">published {formatDateTime(Date.parse(u.available.publishedAt))}</span>
			</h3>
			{#if releaseNotes}
				<div class="release-notes">{@html releaseNotes}</div>
			{/if}
			<p class="small"><a href={u.available.url} target="_blank" rel="noreferrer">On GitHub</a></p>
		</div>
		{#if u.installed}
			<form method="POST" action="?/update" use:enhance={() => async ({ update }) => update({ reset: false })}>
				<button class="button-primary" type="submit" disabled={!!u.blocker || !!updateTask}>Update to {u.available.version}</button>
				{#if u.blocker}<p class="small muted">{u.blocker}</p>{/if}
			</form>
		{:else}
			<p class="small muted">
				A source checkout updates with git: <code>git pull && npm ci && npm run build</code>, then restart it. An installed
				MineShell (<a href="https://github.com/{u.repo}#install" target="_blank" rel="noreferrer">installer</a>) updates
				here.
			</p>
		{/if}
	{:else if u.check?.latest}
		<p class="muted">This is the newest version.</p>
	{/if}

	<form method="POST" action="?/checkUpdate" use:enhance class="check-row">
		<button class="button" type="submit">Check now</button>
		<span class="small muted">
			{#if u.check}
				Last checked {formatDateTime(u.check.checkedAt)}{#if u.check.error}: <span class="error-text">{u.check.error}</span>{/if}
			{:else}
				Not checked yet.
			{/if}
		</span>
	</form>
</section>

<section class="panel">
	<h2>Automatic checks</h2>
	<form method="POST" action="?/updateAuto" use:enhance={() => async ({ update }) => update({ reset: false })}>
		<div class="check field">
			<input id="autoCheck" name="autoCheck" type="checkbox" bind:checked={autoCheck} />
			<label for="autoCheck">Look for a new version every 12 hours</label>
		</div>
		<p class="small muted">
			It asks GitHub for the latest release of {u.repo}. A new version shows in the top bar and here; nothing is installed
			until you press Update.
		</p>
		<button class="button" type="submit">Save</button>
	</form>
</section>
{:else if tab === 'activity'}
<section class="panel">
	<h2>Recent actions</h2>
	{#if data.recent.length === 0}
		<p class="muted">Nothing recorded yet.</p>
	{:else}
		<table class="stacked activity-table">
			<thead>
				<tr><th>When</th><th>Server</th><th>Action</th><th>Detail</th></tr>
			</thead>
			<tbody>
				{#each data.recent as entry (entry.id)}
					<tr>
						<td class="small nowrap faint">{formatDateTime(entry.timestamp)}</td>
						<td class="small mono">{entry.instanceId ?? '-'}</td>
						<td class="small">{entry.action}</td>
						<td class="small muted wrap">{entry.detail ?? ''}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>
{:else}
<section class="panel">
	<div class="panel-head">
		<div>
			<h2>systemd</h2>
			<p>
				MineShell runs each server as a systemd user unit, <code>{data.paths.templateUnit}</code>, under
				the account MineShell runs as. One template unit serves every instance; the per-instance details
				live in environment files.
			</p>
		</div>
		<form method="POST" action="?/installUnit" use:enhance>
			<button class="button-primary" type="submit">
				{data.systemd.unitInstalled ? 'Reinstall unit file' : 'Install unit file'}
			</button>
		</form>
	</div>

	{#if !data.systemd.available}
		<div class="notice error">
			<p>
				<code>systemctl</code> is not reachable: {data.systemd.message}
			</p>
			<p>
				MineShell needs the user's systemd instance: run it as a normal user with lingering enabled, for
				example as a user service (see <code>docs/DEPLOYMENT.md</code>), not from a system service or cron.
			</p>
		</div>
	{:else if !data.systemd.unitInstalled}
		<div class="notice warning">
			<p>The unit file is not installed yet, so servers cannot start.</p>
		</div>
	{:else}
		<div class="notice success">
			<p>Unit installed at <code><PathText path="{data.paths.unitDir}/{data.paths.templateUnit}" /></code>.</p>
		</div>
	{/if}

	<p class="muted small">
		Run <code>loginctl enable-linger $USER</code> once so servers keep running after you log out.
	</p>

	<button class="button-quiet" onclick={() => (showUnit = !showUnit)}>
		{showUnit ? 'Hide unit file' : 'Show unit file'}
	</button>
	{#if showUnit}
		<pre class="unit">{data.unitPreview}</pre>
	{/if}
</section>

<section class="panel">
	<h2>Player editor</h2>
	<form method="POST" action="?/itemIcons" use:enhance={() => async ({ update }) => update({ reset: false })}>
		<div class="check field">
			<input id="itemIcons" name="itemIcons" type="checkbox" bind:checked={itemIcons} />
			<label for="itemIcons">Show item pictures</label>
		</div>
		<p class="small muted">
			Inventories show each item's picture, read from the server's mod jars and Minecraft's client and drawn in the
			browser. Off, they show names only: nothing is read or drawn, which spares memory and time on big packs.
		</p>
		<button class="button" type="submit">Save</button>
	</form>
</section>

<section class="panel">
	<h2>Where things live</h2>
	<dl class="paths">
		<div><dt>Data</dt><dd class="mono"><PathText path={data.paths.data} /></dd></div>
		<div><dt>Instances</dt><dd class="mono"><PathText path={data.paths.instances} /></dd></div>
		<div><dt>Unit environment files</dt><dd class="mono"><PathText path={data.paths.units} /></dd></div>
	</dl>
</section>
{/if}
</div>

<style>
	.release {
		margin: var(--space-3) 0;
		padding: var(--space-3);
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}

	.release h3 {
		margin: 0 0 var(--space-2);
		font-size: 1rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 0.8rem;
		align-items: baseline;
	}

	.release-notes {
		font-size: 0.92rem;
		overflow-wrap: anywhere;
	}

	.release-notes :global(h2) {
		font-size: 0.95rem;
	}

	.update-log {
		max-height: 16rem;
		overflow: auto;
		font-size: 0.8rem;
		white-space: pre-wrap;
	}

	.check-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		margin-top: var(--space-3);
	}

	.error-text {
		color: var(--error);
	}

	.plain-list {
		list-style: none;
		padding: 0;
		margin: 0 0 var(--space-3);
		display: grid;
		gap: var(--space-1);
	}

	.plain-list li {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 0.8rem;
		align-items: baseline;
	}

	.usage-heading {
		margin-top: var(--space-5);
	}

	.num {
		text-align: right;
	}

	.default-form {
		display: inline;
	}

	.java-download {
		margin-top: var(--space-5);
	}

	/* Sections rather than boxes, as on a server's Settings. */
	.app-settings {
		max-width: 62rem;
	}

	.app-settings :global(.panel) {
		background: none;
		border: 0;
		border-radius: 0;
		padding: 0;
		margin: 0 0 2rem;
	}

	.app-settings :global(.panel > h2),
	.app-settings :global(.panel-head h2) {
		font-size: 1.05rem;
		margin-bottom: 0.3rem;
	}

	.app-settings :global(table) {
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		border-collapse: separate;
		border-spacing: 0;
		overflow: hidden;
	}

	.app-settings :global(th) {
		padding: 0.7rem var(--space-3);
		font-weight: 400;
		color: var(--text-faint);
	}

	.paths div {
		display: grid;
		grid-template-columns: 13rem minmax(0, 1fr);
		gap: var(--space-3);
		padding: 0.75rem var(--space-4);
		border-top: 1px solid var(--line);
	}

	.paths div:first-child {
		border-top: 0;
	}

	.unit {
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-3);
		margin-top: var(--space-3);
		overflow-x: auto;
		font-family: var(--font-mono);
		font-size: 0.75rem;
	}

	.inline-form {
		display: flex;
		gap: var(--space-3);
		align-items: flex-end;
		flex-wrap: wrap;
		margin-top: var(--space-4);
	}

	/* A field's own bottom margin left the button beside it sitting lower than the select. */
	.inline-form .field {
		margin-bottom: 0;
	}

	.grow {
		flex: 1 1 18rem;
		margin-bottom: 0;
	}

	.paths {
		font-size: 0.9rem;
		margin: var(--space-3) 0 0;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
	}

	.paths dt {
		color: var(--text);
	}

	.paths dd {
		margin: 0;
		min-width: 0;
	}

	.wrap {
		overflow-wrap: anywhere;
	}

	.right {
		text-align: right;
	}

	td button {
		font-size: 0.82rem;
		padding: 0.2rem 0.5rem;
	}

	@media (max-width: 60rem) {
		/* Name and path one under the other: side by side the path had a sliver of the width. */
		.paths div {
			grid-template-columns: minmax(0, 1fr);
			gap: 0.15rem;
		}

		/* Wide tables become a card per row: too many columns for a phone, where scrolling
		   them sideways inside their box looked cut off. */
		.stacked,
		.stacked tbody,
		.stacked tr,
		.stacked td {
			display: block;
		}

		.stacked {
			overflow: visible;
		}

		.stacked thead {
			display: none;
		}

		.stacked tr {
			padding: 0.7rem var(--space-4);
			border-top: 1px solid var(--line);
		}

		.stacked tr:first-child {
			border-top: 0;
		}

		.stacked td {
			padding: 0.1rem 0;
			border: 0;
			text-align: left;
		}

		.java-table td:first-child {
			font-weight: 600;
		}

		.java-table td.right {
			margin-top: var(--space-2);
		}

		/* When and server on one line, then what happened. */
		.activity-table td:nth-child(-n + 2) {
			display: inline;
			margin-right: var(--space-2);
		}
	}
</style>
