<script lang="ts">
	import CrashDiagnosis from '#lib/components/CrashDiagnosis.svelte';
	import { fitToViewport } from '#lib/shared/fitToViewport.js';
	import { formatBytes, formatDateTime, formatRelative, formatSeconds } from '#lib/shared/format.js';

	let { data } = $props();

	let list = $state<'runs' | 'files'>('runs');
	// Opening a file from the URL shows the file list.
	$effect(() => {
		if (data.view?.kind === 'file') list = 'files';
	});

	const base = $derived(`/instances/${encodeURIComponent(data.instance.id)}/logs`);

	function duration(run: { startedAt: number; endedAt: number | null }) {
		if (!run.endedAt) return '';
		const s = Math.round((run.endedAt - run.startedAt) / 1000);
		return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
	}

	/** How a run ended, from systemd's lines. 143 is Java answering SIGTERM: a normal stop. */
	function outcome(run: { endedAt: number | null; exit: string | null; failure: string | null }, newest: boolean) {
		if (!run.endedAt) return newest && data.running ? { label: 'running now', tone: 'running' } : { label: 'no end recorded', tone: '' };
		if (run.failure && !/status=143\b/.test(run.exit ?? '')) return { label: run.exit ?? run.failure, tone: 'bad' };
		return { label: 'stopped', tone: '' };
	}
</script>

<div class="logs">
	<section class="list">
		<div class="switcher">
			<button class:active={list === 'runs'} onclick={() => (list = 'runs')}>Runs ({data.runs.length})</button>
			<button class:active={list === 'files'} onclick={() => (list = 'files')}>Files ({data.files.length})</button>
		</div>
		<ul use:fitToViewport>
			{#if list === 'runs'}
				{#each data.runs as run, i (run.invocation)}
					{@const end = outcome(run, i === 0)}
					<li>
						<a href="{base}?run={run.invocation}" class:current={data.view?.key === run.invocation}>
							<span class="dot" class:running={end.tone === 'running'} class:failed={end.tone === 'bad'}></span>
							<span class="item">
								<span>{formatDateTime(run.startedAt)}</span>
								<span class="sub" class:bad={end.tone === 'bad'} class:good={end.tone === 'running'}
									>{end.label}{run.endedAt ? ` after ${duration(run)}` : ''}{data.startTimes[run.invocation] !== undefined
										? ` · started in ${formatSeconds(data.startTimes[run.invocation])}`
										: ''}</span
								>
								{#if data.crashCauses[run.invocation]}<span class="sub cause">{data.crashCauses[run.invocation]}</span>{/if}
							</span>
						</a>
					</li>
				{:else}
					<li class="muted small">The journal holds no runs of this server.</li>
				{/each}
			{:else}
				{#each data.files as file (file.path)}
					<li>
						<a href="{base}?file={encodeURIComponent(file.path)}" class:current={data.view?.key === file.path}>
							<span class="dot" class:failed={file.path.startsWith('crash-reports/')}></span>
							<span class="item">
								<span class="mono path">{file.path}</span>
								<span class="sub faint">{formatDateTime(file.modifiedAt)} · {formatBytes(file.size)}</span>
							</span>
						</a>
					</li>
				{:else}
					<li class="muted small">No crash reports or log files yet.</li>
				{/each}
			{/if}
		</ul>
	</section>

	<section class="viewer">
		{#if data.view}
			{@const run = data.runs.find((r) => r.invocation === data.view?.key)}
			{@const file = data.files.find((f) => f.path === data.view?.key)}
			<div class="viewer-head">
				<h2 class:mono={!!file}>{run ? formatDateTime(run.startedAt) : (file?.path ?? '')}</h2>
				<span class="faint small">
					{#if run}started {formatRelative(run.startedAt)}{:else if file}{formatBytes(file.size)}{/if}
				</span>
			</div>
			{#if data.diagnosis}
				{#await data.diagnosis}
					<p class="muted small">Working out what went wrong.</p>
				{:then diagnosis}
					{#if diagnosis.length}
						<p class="small muted">Diagnosed against the mods installed now, which may differ from that run's.</p>
					{/if}
					<CrashDiagnosis {diagnosis} fixAction={`/instances/${encodeURIComponent(data.instance.id)}?/modFix`} />
				{/await}
			{/if}
			{#if data.view.truncated}
				<p class="hint">Long log: only its end is shown{data.view.kind === 'file' ? '; download the whole file from Files' : ''}.</p>
			{/if}
			<pre class="mono" use:fitToViewport>{data.view.text || '(empty)'}</pre>
		{:else}
			<div class="empty">
				<p>
					Pick a run or a file. Runs come from the systemd journal, which keeps a limited amount; the server's own
					<code>logs/</code> and <code>crash-reports/</code> go back further.
				</p>
			</div>
		{/if}
	</section>
</div>

<style>
	.logs {
		display: grid;
		grid-template-columns: minmax(16rem, 19rem) minmax(0, 1fr);
		gap: 1.25rem;
		align-items: start;
	}

	@media (max-width: 800px) {
		.logs {
			grid-template-columns: 1fr;
		}
	}

	.switcher {
		display: flex;
		gap: 2px;
		padding: 3px;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
	}

	.switcher button {
		flex: 1;
		border: 0;
		background: transparent;
		color: var(--text-muted);
		font-weight: 400;
		padding: 0.3rem 0;
	}

	.switcher button.active {
		background: var(--panel-raised);
		color: var(--text);
	}

	.list ul {
		list-style: none;
		padding: 0;
		margin: 0.6rem 0 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.list a {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		padding: 0.55rem 0.6rem;
		border-radius: var(--radius);
		color: inherit;
		text-decoration: none;
		font-size: 0.9rem;
	}

	.list a .dot {
		margin-top: 0.4rem;
	}

	.list a:hover,
	.list a.current {
		background: var(--panel);
	}

	.item {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.path {
		overflow-wrap: anywhere;
	}

	.sub {
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	.bad {
		color: var(--error);
	}

	.good {
		color: var(--accent-hover);
	}

	.viewer {
		min-width: 0;
	}

	.viewer-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: 0.75rem;
	}

	.viewer-head h2 {
		font-size: 1.05rem;
		overflow-wrap: anywhere;
	}

	.viewer-head h2.mono {
		font-size: 0.95rem;
	}

	.viewer pre {
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		padding: 0.75rem 0.9rem;
		overflow: auto;
		font-size: 0.8rem;
		line-height: 1.6;
		margin: 0;
	}
</style>
