<script lang="ts">
	import CrashDiagnosis from '#lib/components/CrashDiagnosis.svelte';
	import { fitToViewport } from '#lib/shared/fitToViewport.js';
	import { formatBytes, formatDateTime } from '#lib/shared/format.js';

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
		if (!run.endedAt) return { label: newest && data.running ? 'running now' : 'no end recorded', tone: '' };
		if (run.failure && !/status=143\b/.test(run.exit ?? '')) return { label: run.exit ?? run.failure, tone: 'bad' };
		return { label: 'stopped', tone: '' };
	}
</script>

<div class="logs">
	<section class="panel list">
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
							<span>{formatDateTime(run.startedAt)}</span>
							<span class="small" class:bad={end.tone === 'bad'}>{end.label}{run.endedAt ? ` after ${duration(run)}` : ''}</span>
						</a>
					</li>
				{:else}
					<li class="muted small">The journal holds no runs of this server.</li>
				{/each}
			{:else}
				{#each data.files as file (file.path)}
					<li>
						<a href="{base}?file={encodeURIComponent(file.path)}" class:current={data.view?.key === file.path}>
							<span class="mono small">{file.path}</span>
							<span class="small faint">{formatDateTime(file.modifiedAt)} · {formatBytes(file.size)}</span>
						</a>
					</li>
				{:else}
					<li class="muted small">No crash reports or log files yet.</li>
				{/each}
			{/if}
		</ul>
	</section>

	<section class="panel viewer">
		{#if data.view}
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
		grid-template-columns: minmax(16rem, 22rem) 1fr;
		gap: var(--space-4);
		align-items: start;
	}

	.logs > .panel {
		margin: 0;
	}

	@media (max-width: 800px) {
		.logs {
			grid-template-columns: 1fr;
		}
	}

	.list ul {
		list-style: none;
		padding: 0;
		margin: var(--space-3) 0 0;
		overflow-y: auto;
	}

	.list a {
		display: flex;
		flex-direction: column;
		padding: var(--space-2);
		border-radius: var(--radius);
		color: inherit;
		text-decoration: none;
	}

	.list a:hover,
	.list a.current {
		background: var(--bg-sunken);
	}

	.bad {
		color: var(--error);
	}

	.viewer {
		min-width: 0;
	}

	.viewer pre {
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-3);
		overflow: auto;
		font-size: 0.8rem;
		margin: 0;
	}

	.switcher {
		display: flex;
		gap: var(--space-1);
	}

	.switcher button.active {
		background: var(--bg-sunken);
	}
</style>
