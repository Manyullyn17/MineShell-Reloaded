<script lang="ts">
	import { enhance } from '$app/forms';
	import Flash from '#lib/components/Flash.svelte';
	import SnapshotPolicyFields from '#lib/components/SnapshotPolicyFields.svelte';
	import { formatBytes, formatDateTime } from '#lib/shared/format.js';

	let { data, form } = $props();

	let showUnit = $state(false);
	let manualJava = $state('');
	// Re-synced after a save; see the bind/$effect note in CLAUDE.md.
	// svelte-ignore state_referenced_locally
	let snap = $state({ ...data.snapshots });
	$effect(() => {
		snap = { ...data.snapshots };
	});
</script>

<svelte:head><title>Settings - MineShell</title></svelte:head>

<h1>Settings</h1>

<Flash {form} />

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
			<p>Unit installed at <code>{data.paths.unitDir}/{data.paths.templateUnit}</code>.</p>
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
		<table>
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
						<td class="mono small wrap">{java.path}</td>
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

<section class="panel">
	<div class="panel-head">
		<div>
			<h2>New server defaults</h2>
			<p>Memory, JVM preset, restart behaviour, console and game settings a new server starts with.</p>
		</div>
		<a class="button" href="/settings/defaults">Edit defaults</a>
	</div>
</section>

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

<section class="panel">
	<h2>Where things live</h2>
	<dl class="paths">
		<dt>Data</dt>
		<dd class="mono wrap">{data.paths.data}</dd>
		<dt>Instances</dt>
		<dd class="mono wrap">{data.paths.instances}</dd>
		<dt>Unit environment files</dt>
		<dd class="mono wrap">{data.paths.units}</dd>
	</dl>
</section>

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
	{#if data.curseforge.source === 'saved'}
		<form method="POST" action="?/removeCurseforgeKey" use:enhance class="inline-form">
			<button class="button-quiet" type="submit">Remove saved key</button>
		</form>
	{/if}
</section>

<section class="panel">
	<h2>Recent actions</h2>
	{#if data.recent.length === 0}
		<p class="muted">Nothing recorded yet.</p>
	{:else}
		<table>
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

<style>
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

	h1 {
		margin-bottom: var(--space-5);
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

	.grow {
		flex: 1 1 18rem;
		margin-bottom: 0;
	}

	.paths {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: var(--space-2) var(--space-4);
		font-size: 0.9rem;
		margin: 0;
	}

	.paths dt {
		color: var(--text-faint);
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
</style>
