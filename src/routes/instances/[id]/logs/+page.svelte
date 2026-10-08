<script lang="ts">
	import { tick } from 'svelte';
	import { page } from '$app/state';
	import CrashDiagnosis from '#lib/components/CrashDiagnosis.svelte';
	import Flash from '#lib/components/Flash.svelte';
	import { enhance } from '#lib/shared/forms.js';
	import { segments } from '#lib/shared/highlight.js';
	import { fitToViewport } from '#lib/shared/fitToViewport.js';
	import { formatBytes, formatDateTime, formatRelative, formatSeconds } from '#lib/shared/format.js';

	let { data, form } = $props();

	let asking = $state<'analyse' | 'share' | null>(null);
	/** Shows the button busy while mclo.gs answers. */
	const busy = (what: 'analyse' | 'share') => () => {
		asking = what;
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			asking = null;
		};
	};
	const analysis = $derived(form && 'mclogs' in form && form.mclogs && form.mclogs.key === data.view?.key ? form.mclogs : null);

	let list = $state<'runs' | 'files'>('runs');
	// Opening a file from the URL shows the file list.
	$effect(() => {
		if (data.view?.kind === 'file') list = 'files';
	});

	const base = $derived(`/instances/${encodeURIComponent(data.instance.id)}/logs`);
	/** A log was picked (not just the newest shown by default): on a phone the list then steps aside for it. */
	const picked = $derived(page.url.searchParams.has('run') || page.url.searchParams.has('file'));
	const listHref = $derived(data.query ? `${base}?q=${encodeURIComponent(data.query)}` : base);

	function duration(run: { startedAt: number; endedAt: number | null }) {
		if (!run.endedAt) return '';
		const s = Math.round((run.endedAt - run.startedAt) / 1000);
		return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
	}

	/** A link to a run or file, keeping the search. */
	function open(kind: 'run' | 'file', key: string) {
		const q = data.query ? `&q=${encodeURIComponent(data.query)}` : '';
		return `${base}?${kind}=${encodeURIComponent(key)}${q}`;
	}

	// ---- the open log, searched: matching lines alone, or all of it with the matches marked.
	let onlyMatches = $state(true);
	const needle = $derived(data.query.toLowerCase());
	/** Matching lines of the part shown, with the index of each one's first mark. */
	const shownMatches = $derived.by(() => {
		if (!needle || !data.view) return [];
		const out: { first: number }[] = [];
		let hits = 0;
		for (const text of data.view.text.split('\n')) {
			const lower = text.toLowerCase();
			let n = 0;
			for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) n++;
			if (n) out.push({ first: hits });
			hits += n;
		}
		return out;
	});
	/**
	 * Where the n-th of all matching lines is among the marks shown: the part
	 * shown is the log's end, so the last of them are the ones in it.
	 */
	const markOf = (n: number, total: number) => shownMatches[n - (total - shownMatches.length)]?.first;
	let viewerPre: HTMLPreElement | null = $state(null);

	/** From a matching line to that place in the whole log. */
	async function showInContext(first: number) {
		onlyMatches = false;
		await tick();
		viewerPre?.querySelectorAll('mark')[first]?.scrollIntoView({ block: 'center' });
	}

	/** How a run ended, from systemd's lines. 143 is Java answering SIGTERM: a normal stop. */
	function outcome(run: { endedAt: number | null; exit: string | null; failure: string | null }, newest: boolean) {
		if (!run.endedAt) return newest && data.running ? { label: 'running now', tone: 'running' } : { label: 'no end recorded', tone: '' };
		if (run.failure && !/status=143\b/.test(run.exit ?? '')) return { label: run.exit ?? run.failure, tone: 'bad' };
		return { label: 'stopped', tone: '' };
	}
</script>

<div class="logs" class:picked>
	<section class="list">
		<form class="search" method="GET" action={base} role="search">
			<input type="search" name="q" value={data.query} placeholder="Search all runs and log files" aria-label="Search all logs" />
			<button class="button-quiet" type="submit">Search</button>
		</form>
		{#if data.search}
			{#await data.search}
				<p class="muted small searching">Searching the journal and every log file.</p>
			{:then found}
				<div class="results-head small">
					<span class="muted">
						{found.runs.length + found.files.length
							? `In ${found.runs.length} run${found.runs.length === 1 ? '' : 's'} and ${found.files.length} file${found.files.length === 1 ? '' : 's'}`
							: 'Nothing found'}{found.partial ? ' (stopped early: some old files not searched)' : ''}
					</span>
					<a href={base}>Clear</a>
				</div>
				<ul class="results" use:fitToViewport>
					{#each [...found.runs, ...found.files] as hit (hit.kind + hit.key)}
						<li>
							<a href={open(hit.kind, hit.key)} class:current={data.view?.key === hit.key}>
								<span class="item">
									<span class:mono={hit.kind === 'file'} class="path">
										{hit.kind === 'run' ? formatDateTime(hit.at) : hit.key}
										<span class="faint small">· {hit.count} line{hit.count === 1 ? '' : 's'}</span>
									</span>
									{#each hit.lines as line, i (i)}
										<span class="snippet mono">{#each segments(line, found.query) as part, j (j)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
									{/each}
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{/await}
		{:else}
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
								<span>{formatDateTime(run.startedAt)}{#if data.bisectRuns.includes(run.invocation)} <span class="tag">bisect test</span>{/if}</span>
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
		{/if}
	</section>

	<section class="viewer">
		{#if data.view}
			{@const run = data.runs.find((r) => r.invocation === data.view?.key)}
			{@const file = data.files.find((f) => f.path === data.view?.key)}
			<a class="back small" href={listHref}>← All runs and files</a>
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
			<div class="mclogs small">
				<form method="POST" action="?/mclogsAnalyse" use:enhance={busy('analyse')}>
					<input type="hidden" name="kind" value={data.view.kind} />
					<input type="hidden" name="key" value={data.view.key} />
					<button class="button-quiet" type="submit" disabled={asking !== null}>
						{asking === 'analyse' ? 'Asking mclo.gs…' : 'Second opinion from mclo.gs'}
					</button>
				</form>
				{#if data.share}
					<span>Shared: <a href={data.share.url} target="_blank" rel="noreferrer">{data.share.url}</a></span>
					<form method="POST" action="?/mclogsUnshare" use:enhance>
						<input type="hidden" name="kind" value={data.view.kind} />
						<input type="hidden" name="key" value={data.view.key} />
						<button class="button-quiet button-danger" type="submit">Delete from mclo.gs</button>
					</form>
				{:else}
					<form
						method="POST"
						action="?/mclogsShare"
						use:enhance={(input) => {
							if (!confirm('Put this log on mclo.gs at a public link for 90 days? mclo.gs hides IP addresses and home folders; player names stay. You can delete it from here.')) {
								input.cancel();
								return;
							}
							return busy('share')();
						}}
					>
						<input type="hidden" name="kind" value={data.view.kind} />
						<input type="hidden" name="key" value={data.view.key} />
						<button class="button-quiet" type="submit" disabled={asking !== null}>{asking === 'share' ? 'Sharing…' : 'Share on mclo.gs'}</button>
					</form>
				{/if}
				<span class="faint mclogs-note">A second opinion sends the log to mclo.gs to be read, not kept.</span>
			</div>
			{#if form && !form.ok && form.message}
				<Flash {form} />
			{/if}
			{#if analysis}
				<section class="mclogs-result">
					<h3>mclo.gs{analysis.title ? `: ${analysis.title}` : ''}</h3>
					{#if analysis.problems.length}
						<ul>
							{#each analysis.problems as problem, i (i)}
								<li>
									<strong>{problem.message}</strong>{#if problem.line}<span class="faint"> · line {problem.line} of what was sent</span>{/if}
									{#each problem.solutions as solution, j (j)}<div class="solution">→ {solution}</div>{/each}
								</li>
							{/each}
						</ul>
					{:else}
						<p class="muted small">mclo.gs recognises no problem in this log.</p>
					{/if}
					{#if analysis.information.length}
						<p class="faint small">{analysis.information.map((i) => `${i.label}: ${i.value}`).join(' · ')}</p>
					{/if}
				</section>
			{/if}
			{#if data.view.truncated}
				<p class="hint">Long log: only its end is shown{data.view.kind === 'file' ? '; download the whole file from Files' : ''}.</p>
			{/if}
			{#await data.inLog}
				<p class="muted small">Finding the lines with “{data.query}”.</p>
			{:then found}
				{@const all = found ?? []}
				{#if needle}
					<div class="in-log small">
						<span class="muted">
							{all.length ? `${all.length}${all.length >= 5000 ? '+' : ''} line${all.length === 1 ? '' : 's'} with “${data.query}”` : `“${data.query}” is not in this log`}{all.length > shownMatches.length
								? ` (${shownMatches.length} in the part shown below)`
								: ''}
						</span>
						{#if all.length}
							<label class="check"><input type="checkbox" bind:checked={onlyMatches} /> Only those lines</label>
						{/if}
					</div>
				{/if}
				{#if needle && onlyMatches && all.length}
					<div class="matches mono" use:fitToViewport>
						{#each all as m, i (i)}
							{@const mark = markOf(i, all.length)}
							<button
								type="button"
								class="match"
								disabled={mark === undefined}
								title={mark === undefined ? 'Before the part of the log shown here' : 'Show it in the log'}
								onclick={() => mark !== undefined && showInContext(mark)}
								><span class="line-no">{m.line ?? ''}</span><span>{#each segments(m.text, data.query) as part, j (j)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span></button
							>
						{/each}
					</div>
				{:else if needle}
					<pre class="mono" bind:this={viewerPre} use:fitToViewport>{#each segments(data.view.text, data.query) as part, j (j)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</pre>
				{:else}
					<pre class="mono" use:fitToViewport>{data.view.text || '(empty)'}</pre>
				{/if}
			{/await}
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

	.back {
		display: none;
		margin-bottom: 0.5rem;
		text-decoration: none;
	}

	@media (max-width: 800px) {
		.logs {
			grid-template-columns: 1fr;
		}

		/*
		 * One at a time: the list, or the log picked from it. Below the list
		 * the log got what was left of the screen - a line or two.
		 */
		.logs.picked .list,
		.logs:not(.picked) .viewer {
			display: none;
		}

		.back {
			display: inline-block;
		}

		.viewer pre,
		.viewer .matches {
			min-height: 50vh;
		}

		/* No sideways scrolling through a log on a phone. */
		.viewer pre {
			white-space: pre-wrap;
			overflow-wrap: anywhere;
			padding: 0.5rem 0.6rem;
			font-size: 0.74rem;
		}

		.mclogs {
			gap: 0.25rem 0.5rem;
			margin-bottom: 0.5rem;
		}

		.mclogs-note {
			display: none;
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

	.search {
		display: flex;
		gap: var(--space-2);
		margin-bottom: 0.6rem;
	}

	.search input {
		flex: 1;
		min-width: 0;
	}

	.searching {
		margin-top: 0.6rem;
	}

	.results-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--space-2);
	}

	.results-head a {
		flex: none;
	}

	.results {
		list-style: none;
		padding: 0;
		margin: 0.6rem 0 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.results a {
		display: block;
		padding: 0.5rem 0.6rem;
		border-radius: var(--radius);
		color: inherit;
		text-decoration: none;
		font-size: 0.9rem;
	}

	.results a:hover,
	.results a.current {
		background: var(--panel);
	}

	.snippet {
		font-size: 0.72rem;
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	mark {
		background: color-mix(in srgb, var(--warning) 35%, transparent);
		color: inherit;
		border-radius: 2px;
	}

	.in-log {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
		align-items: center;
		margin-bottom: 0.5rem;
	}

	.in-log .check {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		margin: 0;
	}

	.matches {
		display: flex;
		flex-direction: column;
		overflow: auto;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		padding: 0.5rem 0;
		font-size: 0.8rem;
	}

	.match {
		display: flex;
		gap: 0.8rem;
		padding: 0.1rem 0.9rem;
		border: 0;
		border-radius: 0;
		background: none;
		color: var(--text);
		font: inherit;
		text-align: left;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		line-height: 1.6;
	}

	.match:hover:not(:disabled) {
		background: var(--panel);
	}

	.match:disabled {
		opacity: 1;
		cursor: default;
		color: var(--text-muted);
	}

	.line-no {
		flex: none;
		min-width: 3.5rem;
		text-align: right;
		color: var(--text-faint);
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
	.mclogs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		margin-bottom: 0.75rem;
	}

	.mclogs a {
		overflow-wrap: anywhere;
	}

	.mclogs-result {
		margin-bottom: 0.75rem;
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--line);
		border-left: 3px solid var(--info);
		border-radius: var(--radius);
		background: var(--bg-sunken);
	}

	.mclogs-result h3 {
		margin: 0 0 0.4rem;
		font-size: 0.92rem;
	}

	.mclogs-result ul {
		margin: 0 0 0.4rem;
		padding-left: 1.1rem;
		font-size: 0.88rem;
	}

	.mclogs-result strong {
		font-weight: 500;
	}

	.solution {
		color: var(--text-muted);
	}
</style>
