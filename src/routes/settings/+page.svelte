<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import PathText from '#lib/components/PathText.svelte';
	import { page } from '$app/state';
	import Flash from '#lib/components/Flash.svelte';
	import SnapshotPolicyFields from '#lib/components/SnapshotPolicyFields.svelte';
	import AllowDownloadPrompt from '#lib/components/AllowDownloadPrompt.svelte';
	import NotificationFields from '#lib/components/NotificationFields.svelte';
	import { DEFAULT_NOTIFICATION_KINDS, type TargetType } from '#lib/shared/notifications.js';
	import { blockedLabel } from '#lib/shared/downloads.js';
	import { PORT_KIND_LABELS } from '#lib/shared/ports.js';
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
	/** The saved preset whose edit form is open. */
	let editingPreset = $state<string | null>(null);
	// Re-synced after a save; see the bind/$effect note in CLAUDE.md.
	// svelte-ignore state_referenced_locally
	let snap = $state({ ...data.snapshots });
	$effect(() => {
		snap = { ...data.snapshots };
	});

	const notificationValues = () => ({
		type: (data.notifications?.type ?? 'discord') as TargetType,
		kinds: [...(data.notifications?.kinds ?? DEFAULT_NOTIFICATION_KINDS)]
	});
	// svelte-ignore state_referenced_locally
	let notifyValues = $state(notificationValues());
	$effect(() => {
		notifyValues = notificationValues();
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
	// svelte-ignore state_referenced_locally
	let sftpEnabled = $state(data.sftp.enabled);
	$effect(() => {
		sftpEnabled = data.sftp.enabled;
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

	async function removeAllowed(address: string) {
		if (!confirm(`Stop allowing downloads from ${address}?`)) return;
		await fetch(`/api/downloads/allowed?address=${encodeURIComponent(address)}`, { method: 'DELETE' });
		await invalidateAll();
	}

	const portsInfo = streamed(() => data.ports);
	const ports = $derived(portsInfo.ready ? portsInfo.value : null);
	/** The port row whose number is being typed, `<server>:<kind>`. */
	let editingPort = $state<string | null>(null);
	function holderLabel(holder: { pid: number | null; process: string | null; unit: string | null } | null): string {
		if (!holder?.pid) return "another account's program";
		return `${holder.process ?? 'a program'} (pid ${holder.pid}${holder.unit ? `, ${holder.unit}` : ''})`;
	}

	const formatMb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
	const capRunningMb = $derived(data.serverCap.running.reduce((sum, s) => sum + s.ceilingMb, 0));
	const capOutside = $derived(
		data.serverCap.memoryMb || data.serverCap.cpuPercent ? data.serverCap.running.filter((s) => !s.underCap) : []
	);

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

<section class="panel">
	<h2>JVM flag presets</h2>
	<p class="muted">
		Saved flags any server can apply under Settings, Java &amp; memory. A server's settings save its current flags as
		a preset; servers using one keep their flags when it is deleted.
	</p>
	{#if data.jvmPresets.length}
		<ul class="saved-presets">
			{#each data.jvmPresets as preset (preset.id)}
				<li>
					{#if editingPreset === preset.id}
						<form
							method="POST"
							action="?/updatePreset"
							class="preset-edit"
							use:enhance={() => async ({ result, update }) => {
								if (result.type === 'success') editingPreset = null;
								await update({ reset: false });
							}}
						>
							<input type="hidden" name="presetId" value={preset.id} />
							<div class="field">
								<label for="edit-name-{preset.id}">Name</label>
								<input id="edit-name-{preset.id}" name="presetName" value={preset.name} />
							</div>
							<div class="field">
								<label for="edit-description-{preset.id}">Description <span class="muted">(optional)</span></label>
								<input id="edit-description-{preset.id}" name="presetDescription" value={preset.description} />
							</div>
							<div class="field">
								<label for="edit-flags-{preset.id}">Flags</label>
								<textarea id="edit-flags-{preset.id}" name="jvmArgs" rows="2" class="mono" spellcheck="false">{preset.flags}</textarea>
							</div>
							<div class="actions">
								<button class="button-primary" type="submit">Save</button>
								<button class="button-quiet" type="button" onclick={() => (editingPreset = null)}>Cancel</button>
							</div>
						</form>
					{:else}
						<div>
							<span>{preset.name}{#if preset.id === data.defaultPresetId}<span class="tag">new servers</span>{/if}</span>
							{#if preset.description}<span class="small muted">{preset.description}</span>{/if}
							<code class="small">{preset.flags || '(memory settings only)'}</code>
						</div>
						<div class="actions">
							<button class="button-quiet" type="button" onclick={() => (editingPreset = preset.id)}>Edit</button>
							<form
								method="POST"
								action="?/deletePreset"
								use:enhance={({ cancel }) => {
									if (preset.id === data.defaultPresetId && !confirm(`New servers get "${preset.name}". Delete it? They get the built-in default instead.`)) cancel();
								}}
							>
								<input type="hidden" name="presetId" value={preset.id} />
								<button class="button-quiet" type="submit">Delete</button>
							</form>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	<h3 class="java-download">New preset</h3>
	<form method="POST" action="?/savePreset" use:enhance class="preset-form">
		<div class="field">
			<label for="preset-name">Name</label>
			<input id="preset-name" name="presetName" placeholder="My tuning" />
		</div>
		<div class="field">
			<label for="preset-description">Description <span class="muted">(optional)</span></label>
			<input id="preset-description" name="presetDescription" placeholder="What it is for, shown when picking it" />
		</div>
		<div class="field">
			<label for="preset-flags">Flags</label>
			<textarea id="preset-flags" name="jvmArgs" rows="2" class="mono" spellcheck="false" placeholder="-XX:+UseG1GC ..."></textarea>
			<p class="hint">Without <code>-Xms</code>/<code>-Xmx</code>: memory is set per server. A name that exists already replaces that preset.</p>
		</div>
		<button type="submit">Save preset</button>
	</form>
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
{:else if tab === 'ports'}
<section class="panel">
	<h2>Ports</h2>
	<p class="small muted">
		Every port the servers have, and what listens on it now. Two servers with the same port cannot run at once, and a
		port another program holds keeps its server from starting. A changed port is written to the server's config and
		used from its next start.
	</p>
	{#if !ports}
		<p class="muted">Reading the ports...</p>
	{:else}
		{@const clashes = ports.rows.filter((r) => r.clashes.length)}
		{@const taken = ports.rows.filter((r) => r.status === 'taken')}
		{#if clashes.length || taken.length}
			<div class="notice warning">
				<p>
					{#if clashes.length}{clashes.length} {clashes.length === 1 ? 'port is' : 'ports are'} shared between servers.{/if}
					{#if taken.length}{taken.length} {taken.length === 1 ? 'port is' : 'ports are'} held by another program.{/if}
					"Free port" gives one the first port nothing else has.
				</p>
			</div>
		{:else}
			<div class="notice success"><p>No two servers share a port, and no other program holds one of theirs.</p></div>
		{/if}
		<table class="ports">
			<thead>
				<tr><th class="num">Port</th><th>Server</th><th>For</th><th>Now</th><th></th></tr>
			</thead>
			<tbody>
				{#each ports.rows as row (`${row.instanceId}:${row.kind}`)}
					<tr class:problem={row.clashes.length || row.status === 'taken'}>
						<td class="num mono">{row.port}<span class="faint">/{row.protocol}</span></td>
						<td><a href="/instances/{encodeURIComponent(row.instanceId)}/settings?tab=network">{row.name}</a></td>
						<td>
							{PORT_KIND_LABELS[row.kind]}
							{#if row.followsGame}<span class="faint small">(the game port's number)</span>{/if}
						</td>
						<td>
							{#if row.clashes.length}
								<span class="tag bad">also {row.clashes.map((c) => `${c.name} (${PORT_KIND_LABELS[c.kind]})`).join(', ')}</span>
							{/if}
							{#if row.status === 'listening'}
								<span class="tag accent">listening</span>
							{:else if row.status === 'taken'}
								<span class="tag warn">held by {holderLabel(row.holder)}</span>
							{:else}
								<span class="faint small">{row.running ? 'not listening' : 'free'}</span>
							{/if}
						</td>
						<td class="port-actions">
							{#if !row.followsGame && row.kind !== 'query'}
								{#if editingPort === `${row.instanceId}:${row.kind}`}
									<form method="POST" action="?/portChange" use:enhance={() => async ({ result, update }) => { if (result.type === 'success') editingPort = null; await update({ reset: false }); }} class="port-form">
										<input type="hidden" name="instanceId" value={row.instanceId} />
										<input type="hidden" name="kind" value={row.kind} />
										<input name="port" type="number" min="1" max="65535" value={row.port} aria-label="New port" />
										<button type="submit">Save</button>
										<button type="button" class="button-quiet" onclick={() => (editingPort = null)}>Cancel</button>
									</form>
								{:else}
									<form method="POST" action="?/portChange" use:enhance class="port-form">
										<input type="hidden" name="instanceId" value={row.instanceId} />
										<input type="hidden" name="kind" value={row.kind} />
										<input type="hidden" name="free" value="on" />
										{#if row.clashes.length || row.status === 'taken'}<button type="submit">Free port</button>{/if}
										<button type="button" class="button-quiet" onclick={() => (editingPort = `${row.instanceId}:${row.kind}`)}>Change</button>
									</form>
								{/if}
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>

		{#if ports.others.length}
			<h3 class="usage-heading">Other programs listening nearby</h3>
			<table>
				<thead>
					<tr><th class="num">Port</th><th>Program</th></tr>
				</thead>
				<tbody>
					{#each ports.others as other (`${other.protocol}:${other.port}`)}
						<tr>
							<td class="num mono">{other.port}<span class="faint">/{other.protocol}</span></td>
							<td>
								{#if other.oldPortOf}
									{other.oldPortOf}, still on a port it no longer has: restart it to move
								{:else}
									{holderLabel(other.holder)}
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
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

	{#if !data.access.owner}
		<p class="muted small">The CurseForge key is managed by the owner account; everyone's installs use it.</p>
	{:else}
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

	{#if !data.playit.linked && !data.playit.owner}
		<p class="muted small">Not linked. Only the owner account can link MineShell to playit.gg.</p>
	{:else if !data.playit.linked}
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
				takes two agents and four ports (premium: ten and sixteen): an account already at its limit turns the new agent
				away, so remove old ones under <a href={data.playit.dashboard} target="_blank" rel="noreferrer">Agents on playit.gg</a>
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
		{#if data.playit.owner}
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
		{:else}
		<p class="muted small">The playit.gg link and where the agent connects through are managed by the owner account.</p>
		{/if}
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
		{#if data.playit.owner}
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
		{/if}
		<p class="muted small">The agent stays listed on playit.gg after unlinking; remove it there if you like.</p>
	{/if}
</section>
{:else if tab === 'notifications'}
<section class="panel">
	<h2>Notifications</h2>
	<p>
		A message in a Discord channel, a push notification on your phone (ntfy) or a webhook call when something happens to
		a server. A server can send to a destination of its own instead, or as well (its Settings &gt; Automation).
	</p>
	{#if data.notifications?.lastResult}
		{@const last = data.notifications.lastResult}
		<p class="small {last.ok ? 'muted' : 'warn-text'}">Last message {formatDateTime(last.at)}: {last.message}</p>
	{/if}
	<form method="POST" action="?/notifications" use:enhance>
		<NotificationFields bind:values={notifyValues} savedHint={data.notifications?.hint ?? null} idPrefix="notify" />
		<div class="button-row">
			<button class="button-primary" type="submit">Save</button>
			{#if data.notifications}
				<button type="submit" formaction="?/notificationsTest">Send a test message</button>
				<button class="button-quiet" type="submit" formaction="?/notificationsRemove">Stop sending</button>
			{/if}
		</div>
	</form>
</section>
{:else if tab === 'security'}
{#if data.authEnabled}
	<section class="panel">
		<h2>Sign-in</h2>
		<p>
			{#if data.username}Signed in as <strong>{data.username}</strong>.{/if}
			Your password and where you are signed in are on <a href="/account">your account page</a>; other people's
			accounts and what they may do are under <a href="/settings/users">Accounts</a>.
		</p>
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
		{#if !data.access.owner}
			<p class="small muted">Updating MineShell is up to the owner account.</p>
		{:else if u.installed}
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
		{#if data.access.owner}<button class="button" type="submit">Check now</button>{/if}
		<span class="small muted">
			{#if u.check}
				Last checked {formatDateTime(u.check.checkedAt)}{#if u.check.error}: <span class="error-text">{u.check.error}</span>{/if}
			{:else}
				Not checked yet.
			{/if}
		</span>
	</form>
</section>

{#if data.access.owner}
<section class="panel">
	<h2>Automatic checks</h2>
	<form method="POST" action="?/updateAuto" use:enhance={() => async ({ update }) => update({ reset: false })}>
		<div class="check field">
			<input id="autoCheck" name="autoCheck" type="checkbox" class="switch" role="switch" bind:checked={autoCheck} />
			<label for="autoCheck">Look for a new version every 12 hours</label>
		</div>
		<p class="small muted">
			It asks GitHub for the latest release of {u.repo}. A new version shows in the top bar and here; nothing is installed
			until you press Update.
		</p>
		<button class="button" type="submit">Save</button>
	</form>
</section>
{/if}
{:else if tab === 'activity'}
<section class="panel">
	<h2>Recent actions</h2>
	{#if data.recent.length === 0}
		<p class="muted">Nothing recorded yet.</p>
	{:else}
		<table class="stacked activity-table">
			<thead>
				<tr><th>When</th><th>Who</th><th>Server</th><th>Action</th><th>Detail</th></tr>
			</thead>
			<tbody>
				{#each data.recent as entry (entry.id)}
					<tr>
						<td class="small nowrap faint">{formatDateTime(entry.timestamp)}</td>
						<!-- An account's name then; else what MineShell did on its own (scheduler, system). -->
						<td class="small">{entry.username ?? (entry.actor === 'ui' ? '-' : entry.actor)}</td>
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
	<h2>All servers together</h2>
	<p class="small muted">
		One cap on every server combined, on top of each server's own limits, so a few big packs cannot take the whole
		machine. Applied at once, also to running servers. The memory cap is soft: past it the system holds the servers
		back (it frees cache, then swaps or stalls them) instead of killing one, which shows as lag on all of them. Java
		does not give memory back under pressure, so the cap cannot shrink what the servers already hold. The CPU cap
		slows them down: 100% is one full core, {data.serverCap.maxCpu}% all of them. Blank means no cap.
	</p>
	<form method="POST" action="?/serverCap" use:enhance={() => async ({ update }) => update({ reset: false })}>
		<div class="sftp-fields">
			<div class="field">
				<label for="capMemoryMb">Memory cap (MB)</label>
				<input
					id="capMemoryMb"
					name="capMemoryMb"
					type="number"
					min={data.serverCap.minMemoryMb}
					max={data.serverCap.totalMemoryMb}
					step="256"
					placeholder="No cap"
					value={data.serverCap.memoryMb ?? ''}
				/>
				<p class="hint">This machine has {formatMb(data.serverCap.totalMemoryMb)}.</p>
			</div>
			<div class="field">
				<label for="capCpuPercent">CPU cap (%)</label>
				<input
					id="capCpuPercent"
					name="capCpuPercent"
					type="number"
					min="10"
					max={data.serverCap.maxCpu}
					step="10"
					placeholder="No cap"
					value={data.serverCap.cpuPercent ?? ''}
				/>
			</div>
		</div>
		{#if data.serverCap.running.length}
			<p class="small">
				Running now, at most (heap plus what Java needs beyond it, or the server's own limit):
				{#each data.serverCap.running as server, i (server.id)}{i ? ', ' : ''}<a href="/instances/{server.id}">{server.name}</a>
					{formatMb(server.ceilingMb)}{/each}; together {formatMb(capRunningMb)}.
			</p>
			{#if data.serverCap.memoryMb && capRunningMb > data.serverCap.memoryMb}
				<div class="notice warning">
					<p>
						The running servers can take {formatMb(capRunningMb)}, past the {formatMb(data.serverCap.memoryMb)} cap: once they
						grow into it, all of them slow down.
					</p>
				</div>
			{/if}
			{#if capOutside.length}
				<div class="notice warning">
					<p>
						{capOutside.map((s) => s.name).join(', ')}
						{capOutside.length === 1 ? 'was' : 'were'} started outside the servers' slice
						(<code>{data.serverCap.slice}</code>) and {capOutside.length === 1 ? 'comes' : 'come'} under the cap from the next
						start.
					</p>
				</div>
			{/if}
		{/if}
		<button class="button" type="submit">Save</button>
	</form>
</section>

<section class="panel">
	<h2>Player editor</h2>
	<form method="POST" action="?/itemIcons" use:enhance={() => async ({ update }) => update({ reset: false })}>
		<div class="check field">
			<input id="itemIcons" name="itemIcons" type="checkbox" class="switch" role="switch" bind:checked={itemIcons} />
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
	<h2>Files over SFTP</h2>
	<form method="POST" action="?/sftp" use:enhance={() => async ({ update }) => update({ reset: false })}>
		<div class="check field">
			<input id="sftpEnabled" name="sftpEnabled" type="checkbox" class="switch" role="switch" bind:checked={sftpEnabled} />
			<label for="sftpEnabled">Show "Open in file manager" on the Files tab</label>
		</div>
		<p class="small muted">
			An <code>sftp://</code> link to the folder you are looking at, which file managers (Nautilus, Dolphin, WinSCP,
			FileZilla) open over this machine's SSH server, logging in with its account. MineShell runs no file server itself.
			Blank fields use what MineShell finds.
		</p>
		<div class="sftp-fields">
			<div class="field">
				<label for="sftpHost">Host</label>
				<input id="sftpHost" name="sftpHost" value={data.sftp.host ?? ''} placeholder="The address MineShell was opened at" />
			</div>
			<div class="field">
				<label for="sftpPort">SSH port</label>
				<input id="sftpPort" name="sftpPort" type="number" min="1" max="65535" value={data.sftp.port ?? ''} placeholder={String(data.sftp.defaults.port)} />
			</div>
			<div class="field">
				<label for="sftpUser">Account</label>
				<input id="sftpUser" name="sftpUser" value={data.sftp.user ?? ''} placeholder={data.sftp.defaults.user} />
			</div>
		</div>
		<button class="button" type="submit">Save</button>
	</form>
</section>

<section class="panel">
	<h2>Trash</h2>
	<form method="POST" action="?/trashDays" use:enhance={() => async ({ update }) => update({ reset: false })}>
		<div class="field trash-days">
			<label for="trashDays">Keep deleted files for (days)</label>
			<input id="trashDays" name="trashDays" type="number" min="0" max={data.trash.max} step="1" value={data.trash.days} required />
		</div>
		<p class="small muted">
			What is deleted in a server's Files tab goes to its trash first, where it can be restored, and is deleted for good
			after this many days. 0 deletes straight away, with no undo.
		</p>
		<button class="button" type="submit">Save</button>
	</form>
</section>

<section class="panel">
	<h2>Downloads from local addresses</h2>
	<p class="small muted">
		MineShell does not download from this machine, your local network or other non-public addresses: a pack's links
		could otherwise reach services that only listen there. An address allowed here is exempt, exactly that address.
	</p>
	{#each data.downloads.refused as blocked (blocked.host + ' ' + blocked.address)}
		<AllowDownloadPrompt {blocked} />
		<p class="small faint refused-at">
			{formatDateTime(blocked.at)}{#if blocked.by}, for {blocked.by}{/if}: <span class="mono">{blocked.url}</span>
		</p>
	{/each}
	{#if data.downloads.allowed.length}
		<table class="stacked">
			<thead>
				<tr>
					<th>Address</th>
					<th>Allowed</th>
					<th><span class="visually-hidden">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.downloads.allowed as allowed (allowed.address)}
					<tr>
						<td class="mono">{blockedLabel(allowed)}</td>
						<td class="small faint">{formatDateTime(allowed.addedAt)}{#if allowed.addedBy} by {allowed.addedBy}{/if}</td>
						<td class="right">
							<button class="button-quiet" onclick={() => removeAllowed(allowed.address)}>Remove</button>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else if !data.downloads.refused.length}
		<p class="small faint">None allowed, and nothing refused since MineShell started.</p>
	{/if}
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
	.refused-at {
		margin: calc(-1 * var(--space-2)) 0 var(--space-3);
		overflow-wrap: anywhere;
	}

	.ports {
		margin-top: var(--space-3);
	}

	.ports tr.problem td {
		background: color-mix(in srgb, var(--warning) 6%, transparent);
	}

	.port-actions {
		text-align: right;
	}

	.port-form {
		display: inline-flex;
		gap: var(--space-2);
		align-items: center;
	}

	.port-form input[type='number'] {
		width: 7rem;
	}

	.trash-days {
		max-width: 16rem;
	}

	.sftp-fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: var(--space-3);
		margin-bottom: var(--space-3);
	}

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

	.saved-presets {
		list-style: none;
		margin: var(--space-3) 0 0;
		padding: 0;
		display: grid;
		gap: var(--space-1);
	}

	.saved-presets li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-1) 0;
		border-bottom: 1px solid var(--line);
	}

	.saved-presets li > div {
		display: grid;
		gap: 0.15rem;
		min-width: 0;
	}

	.saved-presets code {
		overflow-wrap: anywhere;
	}

	.preset-form {
		max-width: 40rem;
	}

	.saved-presets .preset-edit {
		flex: 1;
		max-width: 40rem;
	}

	.saved-presets .tag {
		margin-left: var(--space-2);
	}

	.saved-presets .actions {
		display: flex;
		gap: var(--space-2);
		align-items: center;
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
		/* A saved preset's Edit and Delete go under it: beside long flags they ran off the edge. */
		.saved-presets li {
			flex-wrap: wrap;
		}

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

		/* When, who and server on one line, then what happened. */
		.activity-table td:nth-child(-n + 3) {
			display: inline;
			margin-right: var(--space-2);
		}
	}
</style>
