<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';

	/**
	 * What the last pack change did with the user's config edits
	 * (configmerge.ts): each file it kept, merged, carried over or left to the
	 * pack, with all sides to compare and a side to pick.
	 */
	type Outcome = 'kept' | 'merged' | 'conflict' | 'carried' | 'both-added' | 'dropped';
	type Entry = { path: string; outcome: Outcome; resolved: 'mine' | 'pack' | null };
	let {
		instanceId,
		report
	}: {
		instanceId: string;
		report: { stamp: string; oldConfigs: string; createdAt: number; entries: Entry[] };
	} = $props();

	type DiffLine = { kind: ' ' | '+' | '-' | '…'; text: string };
	type View = {
		path: string;
		base: string | null;
		mine: string | null;
		pack: string | null;
		current: string | null;
		mineChanges: DiffLine[] | null;
		packChanges: DiffLine[] | null;
	};

	const GROUPS: { title: string; outcomes: Outcome[]; note: string }[] = [
		{
			title: 'Changed by both',
			outcomes: ['conflict', 'both-added'],
			note: 'You and the pack changed the same lines (or both have a file at that path): the pack’s are in place, so the server starts as the pack intends. Compare and pick a side.'
		},
		{ title: 'Merged', outcomes: ['merged'], note: 'You and the pack changed different lines: both are in.' },
		{ title: 'Kept as you had them', outcomes: ['kept', 'carried'], note: 'Files you edited that the pack left alone, and files of your own.' },
		{ title: 'Dropped by the pack', outcomes: ['dropped'], note: 'You had edited these, but the new version no longer ships them. Your copies are in old-configs.' }
	];
	const LABEL: Record<Outcome, string> = {
		kept: 'your edits',
		merged: 'merged',
		conflict: 'pack’s lines in place',
		carried: 'your file',
		'both-added': 'pack’s file in place',
		dropped: 'gone from the pack'
	};

	let open = $state<string | null>(null);
	let view = $state<View | null>(null);
	let viewError = $state('');
	let tab = $state<'mine' | 'pack' | 'current'>('mine');

	async function toggle(path: string) {
		if (open === path) {
			open = null;
			return;
		}
		open = path;
		view = null;
		viewError = '';
		tab = 'mine';
		const params = new URLSearchParams({ stamp: report.stamp, path });
		const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/config-merge?${params}`);
		if (open !== path) return;
		if (res.ok) view = await res.json();
		else viewError = (await res.json().catch(() => null))?.message ?? 'Could not read that file.';
	}

	const attention = $derived(report.entries.filter((e) => (e.outcome === 'conflict' || e.outcome === 'both-added') && !e.resolved).length);
</script>

<section class="merge">
	<h3>Your config edits in the last update</h3>
	<p class="muted small">
		{new Date(report.createdAt).toLocaleString()} · your copies from before are in <code>{report.oldConfigs}/</code>{#if attention}
			· <strong class="warn-text">{attention} to look at</strong>{/if}
	</p>

	{#each GROUPS as group (group.title)}
		{@const entries = report.entries.filter((e) => group.outcomes.includes(e.outcome))}
		{#if entries.length}
			<details open={group.outcomes.includes('conflict') || entries.length <= 5}>
				<summary>{group.title} ({entries.length})</summary>
				<p class="small muted">{group.note}</p>
				<ul class="files">
					{#each entries as entry (entry.path)}
						<li>
							<div class="row">
								<span class="mono path">{entry.path}</span>
								<span class="tag">{entry.resolved ? (entry.resolved === 'mine' ? 'yours, picked' : 'pack’s, picked') : LABEL[entry.outcome]}</span>
								<button type="button" class="button-quiet small" onclick={() => toggle(entry.path)} aria-expanded={open === entry.path}>
									{open === entry.path ? 'Close' : 'Compare'}
								</button>
							</div>
							{#if open === entry.path}
								<div class="compare">
									{#if viewError}
										<p class="warn-text small">{viewError}</p>
									{:else if !view}
										<p class="muted small">Reading the file.</p>
									{:else}
										<div class="tabs" role="tablist">
											<button type="button" role="tab" aria-selected={tab === 'mine'} onclick={() => (tab = 'mine')}>Your changes</button>
											{#if view.packChanges}
												<button type="button" role="tab" aria-selected={tab === 'pack'} onclick={() => (tab = 'pack')}>The pack’s changes</button>
											{/if}
											<button type="button" role="tab" aria-selected={tab === 'current'} onclick={() => (tab = 'current')}>In place now</button>
										</div>
										{#if tab === 'current'}
											<pre class="file">{view.current ?? '(no file)'}</pre>
										{:else}
											{@const diff = tab === 'mine' ? view.mineChanges : view.packChanges}
											{#if diff === null}
												<p class="muted small">Not a text file, or not there.</p>
											{:else if !diff.length}
												<p class="muted small">No difference.</p>
											{:else}
												<pre class="file">{#each diff as line, i (i)}<span class="line" class:add={line.kind === '+'} class:del={line.kind === '-'} class:fold={line.kind === '…'}>{line.kind === '…' ? `… ${line.text}\n` : `${line.kind} ${line.text}${line.text.endsWith('\n') ? '' : '\n'}`}</span>{/each}</pre>
											{/if}
											<p class="faint small">
												{tab === 'mine'
													? view.base === null
														? 'Your file against the pack’s.'
														: 'Your copy against the pack’s original of the version you had.'
													: 'The new version against the pack’s original of the version you had.'}
											</p>
										{/if}
										<form method="POST" action="?/resolveConfig" use:enhance class="button-row">
											<input type="hidden" name="stamp" value={report.stamp} />
											<input type="hidden" name="path" value={entry.path} />
											{#if view.mine !== null}
												<button type="submit" name="use" value="mine">Use mine</button>
											{/if}
											<button type="submit" name="use" value="pack" class="button-quiet">
												{entry.outcome === 'carried' || entry.outcome === 'dropped' ? 'Remove it' : 'Use the pack’s'}
											</button>
										</form>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	{/each}
</section>

<style>
	.merge {
		margin-top: var(--space-4);
		border-top: 1px solid var(--line);
		padding-top: var(--space-3);
	}

	h3 {
		font-size: 0.95rem;
		margin: 0 0 var(--space-1);
	}

	details {
		margin-top: var(--space-2);
	}

	summary {
		cursor: pointer;
		font-size: 0.9rem;
	}

	.files {
		list-style: none;
		padding: 0;
		margin: var(--space-1) 0;
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 0.2rem 0;
		flex-wrap: wrap;
	}

	.path {
		font-size: 0.82rem;
		overflow-wrap: anywhere;
		flex: 1 1 12rem;
		min-width: 0;
	}

	.compare {
		margin: var(--space-1) 0 var(--space-3);
	}

	.tabs {
		display: flex;
		gap: var(--space-1);
		margin-bottom: var(--space-1);
		flex-wrap: wrap;
	}

	.tabs button {
		font-size: 0.82rem;
		padding: 0.2rem 0.6rem;
	}

	.tabs button[aria-selected='true'] {
		background: var(--panel-raised);
		border-color: var(--accent);
	}

	.file {
		max-height: 24rem;
		overflow: auto;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.5rem 0.7rem;
		font-size: 0.78rem;
		line-height: 1.5;
		margin: 0 0 var(--space-1);
	}

	.file {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.add {
		background: color-mix(in srgb, var(--success, #3a3) 18%, transparent);
	}

	.del {
		background: color-mix(in srgb, var(--error) 15%, transparent);
	}

	.fold {
		color: var(--text-faint);
	}

	.warn-text {
		color: var(--error);
	}
</style>
