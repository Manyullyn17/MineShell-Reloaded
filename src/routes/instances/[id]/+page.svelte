<script lang="ts">
	import { enhance } from '$app/forms';
	import { refreshAll } from '$app/navigation';
	import Flash from '#lib/components/Flash.svelte';
	import Sparkline from '#lib/components/Sparkline.svelte';
	import CrashDiagnosis from '#lib/components/CrashDiagnosis.svelte';
	import { formatBytes, formatDateTime, formatDuration, formatRelative } from '#lib/shared/format.js';
	import { avatarTone } from '#lib/shared/avatar.js';

	let { data, form } = $props();

	let confirmName = $state('');
	let showDelete = $state(false);
	let showClone = $state(false);
	const clock = (ms: number) => {
		const seconds = Math.max(0, Math.round(ms / 1000));
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	};
	// Ticks a running profile between polls.
	let now = $state(Date.now());
	$effect(() => {
		if (!data.spark?.active) return;
		const tick = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(tick);
	});

	$effect(() => {
		const timer = setInterval(() => void refreshAll(), 5000);
		return () => clearInterval(timer);
	});

	/**
	 * CPU is summed across cores, so the theoretical ceiling is cores x 100%.
	 * Scaling to that ceiling flattens a server using 40% into an invisible
	 * line on an 800% axis, so the chart tracks the actual peak instead,
	 * rounded up to the next whole core. The full ceiling is only used as an
	 * upper bound.
	 */
	const durationLabel = (seconds: number) => (seconds < 60 ? `${seconds} s` : `${seconds / 60} min`);

	const cpuCeiling = $derived.by(() => {
		const peak = Math.max(0, ...data.cpu.map((p) => p.value));
		const rounded = Math.ceil(peak / 100) * 100;
		return Math.min(data.cpuCores * 100, Math.max(100, rounded));
	});

	const latestCpu = $derived(data.cpu.length ? data.cpu[data.cpu.length - 1].value : null);
	const latestMemory = $derived(data.memory.length ? data.memory[data.memory.length - 1].value : null);


	let copied = $state(false);
	async function copyAddress() {
		await navigator.clipboard?.writeText(`${data.detail.host}:${data.detail.serverPort}`).catch(() => undefined);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
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

<dl class="stats">
	<div>
		<dt>Uptime</dt>
		<dd class="mono">{data.running ? formatDuration(data.summary.uptimeMs) : '-'}</dd>
		<dd class="sub">
			{#if data.summary.startedAt}since {formatDateTime(data.summary.startedAt)}{:else}stopped{/if}{data.summary.restarts
				? ` · ${data.summary.restarts} crash restart${data.summary.restarts === 1 ? '' : 's'}`
				: ''}
		</dd>
	</div>
	<div>
		<dt>Players</dt>
		<dd class="mono">{data.players ? `${data.players.online}/${data.players.max}` : '-'}</dd>
		<dd class="sub"><a href="/instances/{data.instance.id}/players">all players</a></dd>
	</div>
	<div>
		<dt>Tick rate</dt>
		<dd class="mono" class:good={data.tick && data.tick.tps >= 18} class:warn-text={data.tick && data.tick.tps < 18}>
			{data.tick ? data.tick.tps.toFixed(1) : '-'}
		</dd>
		<dd class="sub">{data.tick ? `${data.tick.mspt.toFixed(1)} ms/tick` : 'TPS'}</dd>
	</div>
	<div>
		<dt>Memory</dt>
		<dd class="mono">{data.running && latestMemory !== null ? formatBytes(latestMemory) : '-'}</dd>
		<dd class="sub">of {formatBytes((data.detail.memoryMaxMb ?? 0) * 1024 * 1024)} heap</dd>
	</div>
	<div>
		<dt>CPU</dt>
		<dd class="mono">{data.running && latestCpu !== null ? `${latestCpu.toFixed(0)}%` : '-'}</dd>
		<dd class="sub">{data.cpuCores} core{data.cpuCores === 1 ? '' : 's'}</dd>
	</div>
	<div>
		<dt>Disk</dt>
		<dd class="mono">{formatBytes(data.diskBytes)}</dd>
		<dd class="sub"><a href="/instances/{data.instance.id}/files/usage">where it goes</a></dd>
	</div>
</dl>

<div class="columns">
	<div class="column">
		<section class="panel">
			<div class="panel-head">
				<h2>Performance</h2>
				<nav class="segmented" aria-label="Time range">
					{#each [['1h', '1 h'], ['6h', '6 h'], ['24h', '24 h']] as [value, text] (value)}
						<a
							href="?range={value}"
							aria-current={data.range === value ? 'true' : undefined}
							data-sveltekit-noscroll
							data-sveltekit-replacestate>{text}</a
						>
					{/each}
				</nav>
			</div>
			<div class="charts">
				<Sparkline
					points={data.cpu}
					label="CPU · {data.cpuCores} core{data.cpuCores === 1 ? '' : 's'} available ({data.cpuCores * 100}%)"
					unit="%"
					max={cpuCeiling}
					windowMs={data.rangeMs}
					format={(v) => v.toFixed(0)}
				/>
				<Sparkline
					points={data.memory}
					label="Memory · {data.detail.memoryMaxMb} MB heap allocated"
					max={(data.detail.memoryMaxMb ?? 4096) * 1024 * 1024}
					windowMs={data.rangeMs}
					tone="info"
					format={(v) => formatBytes(v)}
				/>
			</div>
		</section>

		{#if data.running}
			<section class="panel">
				<div class="panel-head">
					<h2>Online now</h2>
					<a class="small" href="/instances/{data.instance.id}/players">All players →</a>
				</div>
				{#if data.players?.names.length}
					<ul class="online">
						{#each data.players.names as name (name)}
							<li>
								<span class="avatar" style="--hue: {avatarTone(name)}" aria-hidden="true"></span>
								<span class="online-name">{name}</span>
								<form method="POST" action="?/kick" use:enhance>
									<input type="hidden" name="name" value={name} />
									<button class="button-quiet small" type="submit">Kick</button>
								</form>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="faint small">{data.players ? 'Nobody is online.' : 'RCON did not answer, so who is online is unknown.'}</p>
				{/if}
			</section>
		{/if}

		{#if data.spark}
			<section class="panel">
				<div class="panel-head">
					<div>
						<h2>Spark profiler</h2>
						<p>
							Records what the server spends its time on, then uploads the result to spark.lucko.me to open in the
							browser.
						</p>
					</div>
				</div>
				{#if data.spark.active}
					<form method="POST" use:enhance class="profiling">
						<span>
							{#if data.spark.active.endsAt > now}
								Profiling, <strong class="mono">{clock(data.spark.active.endsAt - now)}</strong> left
							{:else}
								Waiting for Spark to upload the result
							{/if}
						</span>
						<button formaction="?/profileStop">Stop and upload now</button>
						<button class="button-quiet" formaction="?/profileCancel">Cancel</button>
					</form>
				{:else if data.running}
					<form method="POST" action="?/profile" use:enhance class="row">
						<select name="seconds" aria-label="How long to profile" class="duration">
							{#each data.spark.durations as seconds (seconds)}
								<option value={seconds} selected={seconds === 60}>{durationLabel(seconds)}</option>
							{/each}
						</select>
						<button type="submit">Start profiling</button>
					</form>
				{:else}
					<p class="muted small">Start the server to profile it.</p>
				{/if}
		
				{#if data.spark.uploads.length}
					<table class="uploads">
						<thead>
							<tr><th>When</th><th>What</th><th>Started by</th><th></th></tr>
						</thead>
						<tbody>
							{#each data.spark.uploads as upload (upload.time)}
								<tr>
									<td title={formatDateTime(upload.time)}>{formatRelative(upload.time)}</td>
									<td>{upload.type}</td>
									<td>{upload.user}</td>
									<td class="wrap">
										{#if upload.url}
											<a href={upload.url} target="_blank" rel="noreferrer">Open</a>
										{:else}
											<span class="mono small">{upload.file}</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
					<p class="faint small">Spark lists its uploads for 60 days, including ones started in-game.</p>
				{:else}
					<p class="faint small">Nothing uploaded from this server yet.</p>
				{/if}
			</section>
		{/if}
	</div>

	<div class="column">
		<section class="panel">
			<h2>Connect</h2>
			<div class="address">
				<code class="mono">{data.detail.host}:{data.detail.serverPort}</code>
				<button type="button" onclick={copyAddress}>{copied ? 'Copied' : 'Copy'}</button>
			</div>
			<p class="faint small">
				Can't connect? Allow it through the firewall: <code class="mono">sudo ufw allow {data.detail.serverPort}/tcp</code>
			</p>
		</section>

		<section class="panel">
			<div class="panel-head">
				<h2>Setup</h2>
				<a class="small" href="/instances/{data.instance.id}/settings">Edit in Settings →</a>
			</div>
			<dl class="facts">
				<div>
					<dt>Java</dt>
					<dd title={data.detail.java.path ?? undefined}>
						{#if data.detail.java.path}
							{data.detail.java.majorVersion ? `Java ${data.detail.java.majorVersion}` : 'Java (version unknown)'},
							{data.detail.java.origin === 'explicit'
								? 'pinned'
								: data.detail.java.origin === 'default'
									? `the default for Java ${data.detail.java.majorVersion}`
									: 'auto-matched'}
						{:else}
							<span class="warn-text">No Java {data.detail.java.requiredMajor} found</span>
						{/if}
					</dd>
				</div>
				<div>
					<dt>Memory</dt>
					<dd class="mono">
						{data.detail.memoryMinMb ? `${data.detail.memoryMinMb.toLocaleString()} – ` : ''}{data.detail.memoryMaxMb?.toLocaleString()} MB
					</dd>
				</div>
				<div>
					<dt>Restart on crash</dt>
					<dd>
						{data.detail.autoRestartOnCrash
							? `Yes, up to ${data.detail.crashRestartLimit} times in ${Math.round(data.detail.crashRestartWindowSec / 60)} min`
							: 'No'}
					</dd>
				</div>
				<div>
					<dt>Scheduled restart</dt>
					<dd>
						{data.detail.schedule}
						{#if data.detail.nextRestartAt}
							<span class="faint">({formatRelative(data.detail.nextRestartAt)})</span>
						{/if}
					</dd>
				</div>
				<div>
					<dt>RCON port</dt>
					<dd class="mono">{data.detail.rconPort}</dd>
				</div>
				<div>
					<dt>Directory</dt>
					<dd class="mono wrap">{data.instance.path}</dd>
				</div>
				<div>
					<dt>Created</dt>
					<dd>{formatDateTime(data.detail.createdAt)}</dd>
				</div>
				<div>
					<dt>Last changed</dt>
					<dd>{formatDateTime(data.detail.updatedAt)}</dd>
				</div>
			</dl>
			<details class="jvm">
				<summary>JVM arguments</summary>
				<pre class="mono">{data.detail.jvmArgs}</pre>
			</details>
		</section>

		<section class="panel">
			<form method="POST" action="?/notes" use:enhance={() => async ({ update }) => update({ reset: false })} class="notes">
				<label for="notes"><h2>Notes</h2></label>
				<textarea id="notes" name="notes" rows="3" placeholder="Anything you want to remember about this server."
					>{data.detail.notes ?? ''}</textarea
				>
				<button class="button-quiet" type="submit">Save notes</button>
			</form>
		</section>
	</div>
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
	.profiling {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.profiling span {
		margin-right: var(--space-2);
	}

	.duration {
		width: auto;
	}

	.uploads {
		margin-top: var(--space-4);
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
		margin: 0 0 1.25rem;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		overflow: hidden;
	}

	.stats > div {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: var(--space-4) 1.1rem;
		border-right: 1px solid var(--line);
		margin-right: -1px;
	}

	.stats dt {
		font-size: 0.8rem;
		color: var(--text-faint);
	}

	.stats dd {
		margin: 0;
		font-size: 1.4rem;
		font-weight: 500;
	}

	.stats dd.sub {
		font-size: 0.8rem;
		font-weight: 400;
		color: var(--text-muted);
	}

	.stats .sub a,
	.column .panel-head a {
		text-decoration: none;
	}

	.stats .sub a {
		color: inherit;
	}

	.stats .good {
		color: var(--accent-hover);
	}

	.columns {
		display: grid;
		grid-template-columns: minmax(0, 1.6fr) minmax(18rem, 1fr);
		gap: 1.25rem;
		align-items: start;
	}

	.column {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		min-width: 0;
	}

	.column .panel {
		margin: 0;
		padding: 1.25rem 1.4rem;
	}

	.column .panel-head {
		align-items: center;
	}

	.column h2 {
		font-size: 1.05rem;
	}

	.segmented {
		display: flex;
		flex: none;
		gap: 2px;
		padding: 2px;
		background: var(--bg-sunken);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
	}

	.segmented a {
		padding: 0.2rem 0.65rem;
		border-radius: 3px;
		font-size: 0.8rem;
		color: var(--text-muted);
		text-decoration: none;
		white-space: nowrap;
	}

	.segmented a[aria-current] {
		background: var(--line-strong);
		color: var(--text);
	}

	.charts {
		display: grid;
		gap: 1.1rem;
	}

	.online {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.online li {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0.4rem 0;
		border-top: 1px solid var(--panel-raised);
	}

	.avatar {
		width: 24px;
		height: 24px;
		flex: none;
		border-radius: 3px;
		background: var(--hue);
	}

	.online-name {
		flex: 1;
		font-size: 0.92rem;
	}

	.address {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		margin: var(--space-3) 0;
	}

	.address code {
		flex: 1;
		font-size: 1rem;
		padding: 0.5rem 0.75rem;
	}

	.address + p {
		margin: 0;
	}

	.address + p code {
		white-space: nowrap;
	}

	.facts {
		margin: 0 0 var(--space-3);
		font-size: 0.92rem;
	}

	.facts div {
		display: grid;
		grid-template-columns: 8.5rem minmax(0, 1fr);
		gap: var(--space-3);
		padding: 0.55rem 0;
		border-top: 1px solid var(--panel-raised);
	}

	.facts dt {
		color: var(--text-faint);
	}

	.facts dd {
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

	@media (max-width: 70rem) {
		.columns {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.notes label {
		margin-bottom: var(--space-3);
		color: var(--text);
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
