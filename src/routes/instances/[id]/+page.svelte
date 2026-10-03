<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import Flash from '$lib/components/Flash.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import CrashDiagnosis from '$lib/components/CrashDiagnosis.svelte';
	import { formatBytes, formatDateTime, formatDuration, formatRelative } from '$lib/shared/format';

	let { data, form } = $props();

	let confirmName = $state('');
	let showDelete = $state(false);
	let showClone = $state(false);
	// The players are warned before a delayed stop or restart; "now" is the default.
	let delay = $state('0');
	const clock = (ms: number) => {
		const seconds = Math.max(0, Math.round(ms / 1000));
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	};
	// Ticks the countdown between polls.
	let now = $state(Date.now());
	$effect(() => {
		if (!data.countdown) return;
		const tick = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(tick);
	});

	$effect(() => {
		const timer = setInterval(() => void invalidateAll(), 5000);
		return () => clearInterval(timer);
	});

	/**
	 * CPU is summed across cores, so the theoretical ceiling is cores x 100%.
	 * Scaling to that ceiling flattens a server using 40% into an invisible
	 * line on an 800% axis, so the chart tracks the actual peak instead,
	 * rounded up to the next whole core. The full ceiling is only used as an
	 * upper bound.
	 */
	const cpuCeiling = $derived.by(() => {
		const peak = Math.max(0, ...data.cpu.map((p) => p.value));
		const rounded = Math.ceil(peak / 100) * 100;
		return Math.min(data.cpuCores * 100, Math.max(100, rounded));
	});
</script>

<Flash {form} />

{#if data.instance.status === 'provisioning'}
	<div class="notice info">
		<p>Still being set up. Controls unlock when the install finishes.</p>
	</div>
{:else if data.instance.status === 'failed'}
	<div class="notice error">
		<p>Setup failed: {data.instance.statusMessage}</p>
		<p>The instance directory is still here, so you can retry parts of it from Files.</p>
	</div>
{:else if data.instance.statusMessage}
	<div class="notice warning">
		<p>{data.instance.statusMessage}</p>
		<form method="POST" action="?/dismissNotice" use:enhance>
			<button class="button-quiet" type="submit">Dismiss</button>
		</form>
	</div>
{/if}

{#if !data.eulaAccepted}
	<section class="panel">
		<h2>Accept the Minecraft EULA</h2>
		<p class="muted">
			Mojang requires every server operator to agree to the
			<a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Minecraft EULA</a>
			before the server will run. Accepting here writes <code>eula=true</code> to
			<code>eula.txt</code> in this instance.
		</p>
		<form method="POST" action="?/eula" use:enhance>
			<button class="button-primary" type="submit">I agree to the EULA</button>
		</form>
	</section>
{/if}

{#if data.stuckSince}
	<div class="notice warning">
		<p>
			Started {formatRelative(data.stuckSince)} and still not done starting: the log never reached "Done". It may be
			stuck, typically on a mod waiting for something or a deadlock. The <a href="/instances/{data.instance.id}/console"
				>console</a
			> shows where it stopped; Force stop if it does not move.
		</p>
	</div>
{/if}

{#if data.summary.javaWarning}
	<div class="notice warning"><p>{data.summary.javaWarning}</p></div>
{/if}

<section class="panel controls">
	<form method="POST" action="?/power" use:enhance>
		<div class="button-row">
			{#if data.running}
				<button class="button-primary" name="verb" value="stop">Save and stop</button>
				<button name="verb" value="restart">Restart</button>
				<select name="delay" aria-label="When to stop or restart" bind:value={delay}>
					<option value="0">now</option>
					<option value="60">in 1 minute</option>
					<option value="300">in 5 minutes</option>
					<option value="600">in 10 minutes</option>
					<option value="900">in 15 minutes</option>
				</select>
				<button class="button-danger" name="verb" value="kill">Force stop</button>
			{:else}
				<button
					class="button-primary"
					name="verb"
					value="start"
					disabled={data.instance.status !== 'ready' || !data.eulaAccepted}
				>
					Start
				</button>
			{/if}
			<a class="button" href="/instances/{data.instance.id}/console">Open console</a>
		</div>
	</form>
	{#if data.countdown}
		<form method="POST" action="?/cancelCountdown" use:enhance class="countdown">
			<span>
				{data.countdown.verb === 'stop' ? 'Stopping' : 'Restarting'} in
				<strong class="mono">{clock(data.countdown.at - now)}</strong>
			</span>
			<button class="button-quiet" type="submit">Cancel</button>
		</form>
	{/if}
	<form method="POST" action="?/pin" use:enhance>
		<button class="button-quiet">
			{data.instance.pinned ? 'Unpin from server list' : 'Pin to top of server list'}
		</button>
	</form>
</section>

{#if data.crashTail}
	<section class="panel">
		<div class="panel-head">
			<div>
				<h2>Last output before it stopped</h2>
				<p>The server exited unexpectedly. These are the final journal lines.</p>
			</div>
			<a class="button button-quiet" href="/instances/{data.instance.id}/logs">Earlier runs and logs</a>
		</div>
		{#await data.diagnosis}
			<p class="muted small">Working out what went wrong.</p>
		{:then diagnosis}
			<CrashDiagnosis {diagnosis} fixAction={data.running ? null : '?/modFix'} />
		{/await}
		<pre class="crash">{data.crashTail}</pre>
	</section>
{/if}

<div class="split">
	<section class="panel">
		<h2>Right now</h2>
		<dl class="stats">
			<div>
				<dt>Uptime</dt>
				<dd class="mono">{data.running ? formatDuration(data.summary.uptimeMs) : 'Stopped'}</dd>
			</div>
			<div>
				<dt>Players</dt>
				<dd class="mono">{data.players ? `${data.players.online}/${data.players.max}` : '-'}</dd>
			</div>
			{#if data.tick}
				<div>
					<dt>Tick rate</dt>
					<dd class="mono" class:warn-text={data.tick.tps < 18}>
						{data.tick.tps.toFixed(1)} TPS
						<span class="faint small">{data.tick.mspt.toFixed(1)} ms/tick</span>
					</dd>
				</div>
			{/if}
			<div>
				<dt>Disk used</dt>
				<dd class="mono">{formatBytes(data.diskBytes)}</dd>
			</div>
			<div>
				<dt>Crash restarts</dt>
				<dd class="mono">{data.summary.restarts}</dd>
			</div>
		</dl>

		{#if data.players?.names.length}
			<p class="small muted">Online: {data.players.names.join(', ')}</p>
		{/if}

		<div class="charts">
			<Sparkline
				points={data.cpu}
				label="CPU, {data.cpuCores} core{data.cpuCores === 1 ? '' : 's'} available ({data.cpuCores *
					100}%)"
				unit="%"
				max={cpuCeiling}
				format={(v) => v.toFixed(0)}
			/>
			<Sparkline
				points={data.memory}
				label="Memory of {data.detail.memoryMaxMb} MB allocated"
				max={(data.detail.memoryMaxMb ?? 4096) * 1024 * 1024}
				format={(v) => formatBytes(v)}
			/>
		</div>
	</section>

	<section class="panel">
		<h2>Configuration</h2>
		<dl class="detail">
			<dt>Address</dt>
			<dd class="wrap">
				<span class="mono">{data.detail.host}:{data.detail.serverPort}</span>
				<div class="faint small">
					Can't connect? Also allow it through your firewall:
					<code class="mono">sudo ufw allow {data.detail.serverPort}/tcp</code>
				</div>
			</dd>

			<dt>Minecraft</dt>
			<dd class="mono">{data.detail.minecraftVersion}</dd>

			<dt>Mod loader</dt>
			<dd class="mono">
				{data.instance.modloaderLabel}{data.detail.modloaderVersion
					? ` ${data.detail.modloaderVersion}`
					: ''}
			</dd>

			<dt>Directory</dt>
			<dd class="mono wrap">{data.instance.path}</dd>

			<dt>Java</dt>
			<dd class="wrap">
				{#if data.detail.java.path}
					<span class="mono">
						{data.detail.java.majorVersion
							? `Java ${data.detail.java.majorVersion}`
							: 'Java (version unknown)'}
					</span>
					<span class="faint small">
						{data.detail.java.pinned
							? 'pinned for this server'
							: `auto-matched, Minecraft ${data.detail.minecraftVersion} expects ${data.detail.java.requiredMajor}`}
					</span>
					<div class="faint small mono wrap">{data.detail.java.path}</div>
				{:else}
					<span class="warn-text">
						No Java {data.detail.java.requiredMajor} runtime found. Install one, then rescan in
						settings.
					</span>
				{/if}
			</dd>

			<dt>Memory</dt>
			<dd class="mono">{data.detail.memoryMaxMb} MB max</dd>

			<dt>RCON port</dt>
			<dd class="mono">{data.detail.rconPort}</dd>

			<dt>Restart on crash</dt>
			<dd>
				{data.detail.autoRestartOnCrash
					? `Yes, up to ${data.detail.crashRestartLimit} times`
					: 'No'}
			</dd>

			<dt>Scheduled restart</dt>
			<dd>
				{data.detail.schedule}
				{#if data.detail.nextRestartAt}
					<span class="faint small">({formatRelative(data.detail.nextRestartAt)})</span>
				{/if}
			</dd>

			<dt>Created</dt>
			<dd>{formatDateTime(data.detail.createdAt)}</dd>

			<dt>Last changed</dt>
			<dd>
				{formatDateTime(data.detail.updatedAt)}
				<span class="faint small">({formatRelative(data.detail.updatedAt)})</span>
			</dd>
		</dl>

		<details class="jvm">
			<summary>JVM arguments</summary>
			<pre class="mono">{data.detail.jvmArgs}</pre>
		</details>

		<form method="POST" action="?/notes" use:enhance class="notes">
			<label for="notes">Notes</label>
			<textarea id="notes" name="notes" rows="3" placeholder="Anything you want to remember about this server."
				>{data.detail.notes ?? ''}</textarea
			>
			<button class="button-quiet" type="submit">Save notes</button>
		</form>
	</section>
</div>

<section class="panel">
	<div class="panel-head">
		<div>
			<h2>Copy this server</h2>
			<p>
				A separate server with the same files, mods and settings, on its own ports, to try a pack update or a
				migration on first. World snapshots are not copied.
			</p>
		</div>
		{#if !showClone}
			<button onclick={() => (showClone = true)}>Copy server</button>
		{/if}
	</div>
	{#if showClone}
		<form method="POST" action="?/clone" use:enhance>
			<div class="field">
				<label for="clone-name">Name of the copy</label>
				<input id="clone-name" name="name" value="{data.instance.name} (copy)" maxlength="80" required />
			</div>
			{#if data.instance.status === 'provisioning' || data.running}
				<p class="hint">Stop the server to copy it; a running server's world is still being written.</p>
			{/if}
			<div class="button-row">
				<button class="button-primary" type="submit" disabled={data.running || data.instance.status === 'provisioning'}>
					Copy
				</button>
				<button class="button-quiet" type="button" onclick={() => (showClone = false)}>Cancel</button>
			</div>
		</form>
	{/if}
</section>

<section class="panel danger">
	<div class="panel-head">
		<div>
			<h2>Delete this server</h2>
			<p>Stops the server, removes its systemd unit, and optionally deletes the world and mods.</p>
		</div>
		{#if !showDelete}
			<button class="button-danger" onclick={() => (showDelete = true)}>Delete server</button>
		{/if}
	</div>

	{#if showDelete}
		<form method="POST" action="?/delete" use:enhance>
			<div class="field">
				<label for="confirm">
					Type <strong>DELETE</strong> to confirm you want to remove
					<strong>{data.instance.name}</strong>
				</label>
				<input
					id="confirm"
					name="confirm"
					bind:value={confirmName}
					autocomplete="off"
					placeholder="DELETE"
				/>
			</div>
			<div class="check field">
				<input id="deleteFiles" name="deleteFiles" type="checkbox" />
				<label for="deleteFiles">
					Also delete every file, including the world. This cannot be undone.
				</label>
			</div>
			<div class="button-row">
				<button class="button-danger" type="submit" disabled={confirmName.trim().toUpperCase() !== 'DELETE'}>
					Delete permanently
				</button>
				<button class="button-quiet" type="button" onclick={() => (showDelete = false)}>
					Cancel
				</button>
			</div>
		</form>
	{/if}
</section>

<style>
	.countdown {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.controls {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		flex-wrap: wrap;
		padding: var(--space-3) var(--space-4);
	}

	.split {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(21rem, 1fr));
		gap: var(--space-4);
		align-items: start;
		margin-top: var(--space-4);
	}

	.split .panel {
		margin-top: 0;
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(6rem, 1fr));
		gap: var(--space-3);
		margin: var(--space-4) 0;
		padding: var(--space-3) 0;
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
	}

	.stats dt {
		font-size: 0.72rem;
		color: var(--text-faint);
	}

	.stats dd {
		margin: 0;
		font-size: 1.05rem;
	}

	.charts {
		display: grid;
		gap: var(--space-4);
		margin-top: var(--space-4);
	}

	.detail {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: var(--space-2) var(--space-4);
		margin: var(--space-4) 0;
		font-size: 0.9rem;
	}

	.detail dt {
		color: var(--text-faint);
	}

	.detail dd {
		margin: 0;
		min-width: 0;
	}

	.wrap {
		overflow-wrap: anywhere;
	}

	.jvm summary {
		cursor: pointer;
		font-size: 0.88rem;
		color: var(--text-muted);
	}

	.jvm pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-3);
		margin-top: var(--space-2);
		font-size: 0.75rem;
	}

	.notes {
		margin-top: var(--space-4);
		padding-top: var(--space-4);
		border-top: 1px solid var(--line);
	}

	.notes button {
		margin-top: var(--space-2);
	}

	.crash {
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-3);
		overflow-x: auto;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		max-height: 16rem;
	}

	.danger {
		margin-top: var(--space-4);
		border-color: color-mix(in srgb, var(--error) 30%, var(--line));
	}

	/* Paragraphs carry a global 68ch readability cap, which here left a large
	   dead gap between the text and the delete button. In a single-line panel
	   header the copy should run as wide as the space allows and stop just
	   short of the button instead. */
	.danger .panel-head > div {
		flex: 1 1 auto;
		min-width: 0;
		padding-right: var(--space-4);
	}

	.danger .panel-head p {
		max-width: none;
	}

	.danger .panel-head {
		align-items: center;
		gap: var(--space-2);
	}

	.warn-text {
		color: var(--warning);
	}
</style>
