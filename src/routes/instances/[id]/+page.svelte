<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import { refreshAll } from '$app/navigation';
	import Flash from '#lib/components/Flash.svelte';
	import MemoryAdvice from '#lib/components/MemoryAdvice.svelte';
	import Sparkline from '#lib/components/Sparkline.svelte';
	import CrashDiagnosis from '#lib/components/CrashDiagnosis.svelte';
	import ForgeQuestion from '#lib/components/ForgeQuestion.svelte';
	import { formatBytes, formatDateTime, formatDuration, formatRelative, formatSeconds } from '#lib/shared/format.js';
	import PlayerFace from '#lib/components/PlayerFace.svelte';
	import { applyPackIcon } from '#lib/shared/servericon.js';
	import { streamed } from '#lib/shared/streamed.svelte.js';

	let { data, form } = $props();

	// Streamed: slow the first time on a big pack (the last run's journal, a walk of the
	// folder, every mod jar opened). Kept between the 5 s refreshes, so nothing flickers.
	const key = () => data.instance.id;
	const crashTail = streamed(() => data.crashTail, key);
	const diagnosis = streamed(() => data.diagnosis, key);
	const facesInfo = streamed(() => data.faces);
	const faces = $derived((facesInfo.ready ? facesInfo.value : {}) as Record<string, { id: string; skin: string | null }>);
	const disk = streamed(() => data.disk, key);
	const sparkInfo = streamed(() => data.spark, key);
	const spark = $derived(sparkInfo.ready ? sparkInfo.value : null);

	// A server installed from a pack gets the pack's icon (what Prism shows), the first time
	// it is opened without one; scaled here, since the browser decodes every format.
	let packIconDone = false;
	$effect(() => {
		if (!data.packIconPending || packIconDone) return;
		packIconDone = true;
		void applyPackIcon(data.instance.id).catch(() => undefined);
	});

	const clock = (ms: number) => {
		const seconds = Math.max(0, Math.round(ms / 1000));
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	};
	// Ticks a running profile between polls.
	let now = $state(Date.now());
	$effect(() => {
		if (!spark?.active) return;
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
	/**
	 * What the server holds is the heap plus Java's own memory (classes, compiled
	 * code, threads), so it runs above the heap size; with AlwaysPreTouch the whole
	 * heap counts from the start. The chart's top is the heap size or the highest
	 * value shown, whichever is more - it clipped everything above the heap.
	 * A running server has the heap it started with; a saved change waits for
	 * the next start.
	 */
	const heapMb = $derived(data.detail.runningMemoryMaxMb ?? data.detail.memoryMaxMb ?? 4096);
	const heapPending = $derived(
		data.detail.runningMemoryMaxMb !== null && data.detail.memoryMaxMb !== null && data.detail.runningMemoryMaxMb !== data.detail.memoryMaxMb
	);
	const heapBytes = $derived(heapMb * 1024 * 1024);
	const memoryCeiling = $derived(Math.max(heapBytes, ...data.memory.map((p) => p.value * 1.1)));


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

{#if data.forgeQuestion}
	<ForgeQuestion question={data.forgeQuestion} />
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

{#if crashTail.ready && crashTail.value}
	<section class="panel">
		<div class="panel-head">
			<div>
				{#if data.hungSince}
					<h2>It crashed but is still running</h2>
					<p>
						The server logged a crash {formatRelative(data.hungSince)}, but its process never exited, so it will not
						restart on its own either. Stop it, and Force stop if that does not end it. These are its last journal lines.
					</p>
				{:else}
					<h2>Last output before it stopped</h2>
					<p>The server exited unexpectedly. These are the final journal lines.</p>
				{/if}
			</div>
			<a class="button button-quiet" href="/instances/{data.instance.id}/logs">Earlier runs and logs</a>
		</div>
		{#if !diagnosis.ready}
			<p class="muted small">Working out what went wrong.</p>
		{:else if diagnosis.value}
			<CrashDiagnosis diagnosis={diagnosis.value} fixAction={data.running ? null : '?/modFix'} />
		{/if}
		<pre class="crash">{crashTail.value}</pre>
	</section>
{/if}

{#if data.missingDownloads.length}
	<section class="panel">
		<div class="panel-head">
			<div>
				<h2>Pack files that could not be downloaded</h2>
				<p>
					Download each one and put it in the folder shown (mods also through the Mods tab's upload), or try
					again. A file drops off this list once it is in place.
				</p>
			</div>
		</div>
		<ul class="missing">
			{#each data.missingDownloads as missing (missing.download.target || missing.name)}
				<li>
					<div>
						<span class="mono">{missing.name}</span>
						<span class="faint small">
							{#if missing.download.target}into <span class="mono">{missing.download.target.split('/').slice(0, -1).join('/') || 'the server folder'}</span>,{/if}
							{missing.error}
						</span>
					</div>
					<span class="links">
						{#if missing.page}<a href={missing.page} target="_blank" rel="noreferrer">CurseForge page</a>{/if}
						{#if missing.download.urls[0]}<a href={missing.download.urls[0]} target="_blank" rel="noreferrer">Direct link</a>{/if}
					</span>
				</li>
			{/each}
		</ul>
		<form method="POST" use:enhance class="row">
			<button type="submit" formaction="?/retryDownloads">Try again</button>
			<button type="submit" class="button-quiet" formaction="?/forgetDownloads">Forget the list</button>
		</form>
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
		{#if data.history.start}
			{@const s = data.history.start}
			<!-- A start much slower than usual is worth noticing: a pack update or a new mod. -->
			<dd class="sub" class:warn-text={s.usualMs !== null && s.lastMs > s.usualMs * 1.5 && s.lastMs - s.usualMs > 20_000}>
				{data.running ? 'started in' : 'last start took'} {formatSeconds(s.lastMs)}{s.usualMs !== null ? `, usually ${formatSeconds(s.usualMs)}` : ''}
			</dd>
		{/if}
	</div>
	<div>
		<dt>Players</dt>
		<dd class="mono">{data.players ? `${data.players.online}/${data.players.max}` : '-'}</dd>
		<dd class="sub">
			{#if data.history.peakToday}peak today {data.history.peakToday} · {/if}<a href="/instances/{data.instance.id}/players">all players</a>
		</dd>
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
		<dd class="sub">
			heap up to {formatBytes(heapBytes)}{#if heapPending}<span title="Saved in settings; applies when the server next starts">
					· {formatBytes((data.detail.memoryMaxMb ?? 0) * 1024 * 1024)} after a restart</span
				>{/if}
		</dd>
	</div>
	<div>
		<dt>CPU</dt>
		<dd class="mono">{data.running && latestCpu !== null ? `${latestCpu.toFixed(0)}%` : '-'}</dd>
		<dd class="sub">{data.cpuCores} core{data.cpuCores === 1 ? '' : 's'}</dd>
	</div>
	<div>
		<dt>Disk</dt>
		<dd class="mono">{disk.ready && disk.value ? formatBytes(disk.value.diskBytes) : '…'}</dd>
		<dd class="sub">
			<a href="/instances/{data.instance.id}/files/usage">{disk.ready && disk.value?.worldBytes ? `world ${formatBytes(disk.value.worldBytes)}` : 'where it goes'}</a>
		</dd>
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
							data-sveltekit-reset="false"
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
					label="Memory held · heap up to {formatBytes(heapBytes)}, plus Java's own"
					max={memoryCeiling}
					windowMs={data.rangeMs}
					tone="info"
					format={(v) => formatBytes(v)}
				/>
				{#if data.heap.length > 1 && data.heapMaxBytes}
					<Sparkline
						points={data.heap}
						label="Java heap in use · of {formatBytes(data.heapMaxBytes)}"
						max={data.heapMaxBytes}
						windowMs={data.rangeMs}
						tone="info"
						format={(v) => formatBytes(v)}
					/>
				{/if}
			</div>
			{#await data.memoryAdvice then advice}
				{#if advice}
					<div class="memory-advice">
						<MemoryAdvice {advice} settingsHref="/instances/{data.instance.id}/settings?tab=java" />
					</div>
				{/if}
			{/await}
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
								<PlayerFace id={faces[name]?.id ?? name} skin={faces[name]?.skin ?? null} size={24} />
								<span class="online-name">{name}</span>
								{#if data.history.onlineSince[name]}
									<span class="faint small" title="Online since {formatDateTime(data.history.onlineSince[name])}"
										>{formatSeconds(Date.now() - data.history.onlineSince[name])}</span
									>
								{/if}
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

		{#if data.history.crashes.length}
			{@const crashes = data.history.crashes}
			{@const counts = crashes.reduce((m, c) => (c.cause ? m.set(c.cause, (m.get(c.cause) ?? 0) + 1) : m), new Map<string, number>())}
			{@const repeated = [...counts].sort((a, b) => b[1] - a[1])[0]}
			<section class="panel">
				<div class="panel-head">
					<div>
						<h2>Recent crashes</h2>
						<p>{crashes.length} in the last 30 days{crashes.length === 10 ? ' (newest ten)' : ''}.</p>
					</div>
					<a class="small" href="/instances/{data.instance.id}/logs">Logs →</a>
				</div>
				{#if repeated && repeated[1] > 1}
					<p class="notice warning repeat">The same cause {repeated[1]} times: {repeated[0]}</p>
				{/if}
				<ul class="crash-list">
					{#each crashes as crash (crash.invocation)}
						<li>
							<a href="/instances/{data.instance.id}/logs?run={crash.invocation}">{formatDateTime(crash.at)}</a>
							<span class="small" class:muted={!crash.cause}>
								{crash.cause ?? (crash.diagnosed ? 'Cause not recognised; the log has the details.' : 'Being looked at.')}
							</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if spark}
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
				{#if spark.active}
					<form method="POST" use:enhance class="profiling">
						<span>
							{#if spark.active.endsAt > now}
								Profiling, <strong class="mono">{clock(spark.active.endsAt - now)}</strong> left
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
							{#each spark.durations as seconds (seconds)}
								<option value={seconds} selected={seconds === 60}>{durationLabel(seconds)}</option>
							{/each}
						</select>
						<button type="submit">Start profiling</button>
					</form>
				{:else}
					<p class="muted small">Start the server to profile it.</p>
				{/if}
		
				{#if spark.uploads.length}
					<table class="uploads">
						<thead>
							<tr><th>When</th><th>What</th><th>Started by</th><th></th></tr>
						</thead>
						<tbody>
							{#each spark.uploads as upload (upload.time)}
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
				Can't connect? Allow it through the firewall: <code class="mono">sudo ufw allow {data.detail.serverPort}/tcp</code>{#if data.detail.voicePort}, and voice chat's port: <code class="mono">sudo ufw allow {data.detail.voicePort}/udp</code>{/if}
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
					{#if heapPending}
						<dd class="faint small">running with {data.detail.runningMemoryMaxMb?.toLocaleString()} MB until it restarts</dd>
					{/if}
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

<style>
	.missing {
		list-style: none;
		margin: 0 0 var(--space-4);
		padding: 0;
	}

	.missing li {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.25rem var(--space-4);
		padding: 0.5rem 0;
		border-bottom: 1px solid var(--line);
	}

	.missing li > div {
		display: flex;
		flex-direction: column;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.missing .links {
		display: flex;
		gap: var(--space-4);
		white-space: nowrap;
	}

	.crash-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.crash-list li {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		padding: 0.5rem 0;
		border-top: 1px solid var(--line);
	}

	.crash-list li:first-child {
		border-top: 0;
	}

	.repeat {
		margin: 0 0 var(--space-2);
	}

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





	.warn-text {
		color: var(--warning);
	}
	.memory-advice {
		margin-top: var(--space-3);
	}
</style>
