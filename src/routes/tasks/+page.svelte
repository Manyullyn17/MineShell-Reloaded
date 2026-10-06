<script lang="ts">
	import { enhance } from '$app/forms';
	import Flash from '#lib/components/Flash.svelte';
	import { formatDateTime, formatDuration } from '#lib/shared/format.js';

	let { data, form } = $props();

	type Task = (typeof data.tasks)[number];
	// The stream is the live source once connected; until then, and if it drops,
	// fall back to whatever the load function returned.
	let streamed = $state<Task[] | null>(null);
	const tasks = $derived(streamed ?? data.tasks);
	let expanded = $state<string | null>(null);

	// Progress is pushed rather than polled, so a 300-mod install stays smooth.
	$effect(() => {
		const source = new EventSource('/api/tasks?stream=1');
		source.addEventListener('tasks', (event) => {
			streamed = JSON.parse((event as MessageEvent).data);
		});
		return () => {
			source.close();
			streamed = null;
		};
	});

	const toneOf = (state: string) =>
		state === 'running' ? 'busy' : state === 'done' ? 'running' : state === 'failed' ? 'failed' : '';
</script>

<svelte:head><title>Activity - MineShell</title></svelte:head>

<header class="page-head">
	<h1>Activity</h1>
	<p class="muted">
		Installs and imports run in the background. They are kept here for half an hour after they
		finish, then cleared.
	</p>
</header>

<Flash {form} />

{#if tasks.length === 0}
	<div class="empty">
		<p>Nothing has run yet. Creating a server or installing a modpack shows up here.</p>
	</div>
{:else}
	<div class="stack">
		{#each tasks as task (task.id)}
			<article class="panel task">
				<div class="head">
					<div class="row">
						<span class="dot {toneOf(task.state)}"></span>
						<div>
							<h2>{task.label}</h2>
							<p class="small muted">
								{task.step}
								{#if task.instanceId}
									- <a href="/instances/{task.instanceId}">{task.instanceId}</a>
								{/if}
							</p>
						</div>
					</div>
					<div class="row">
						{#if task.state === 'running'}
							<form method="POST" action="?/cancel" use:enhance>
								<input type="hidden" name="id" value={task.id} />
								<button class="button-quiet button-danger">Cancel</button>
							</form>
						{/if}
						<button class="button-quiet" onclick={() => (expanded = expanded === task.id ? null : task.id)}>
							{expanded === task.id ? 'Hide log' : 'Show log'}
						</button>
					</div>
				</div>

				{#if task.state === 'running'}
					<div class="progress bar" role="progressbar" aria-valuenow={task.progress ?? undefined}>
						<span class:indeterminate={task.progress === null} style="width: {task.progress ?? 100}%"></span>
					</div>
				{/if}

				{#if task.error}
					<p class="notice error">{task.error}</p>
				{/if}

				<p class="small faint meta">
					Started {formatDateTime(task.startedAt)}
					{#if task.finishedAt}
						- took {formatDuration(task.finishedAt - task.startedAt)}
					{/if}
				</p>

				{#if expanded === task.id}
					<pre class="log">{task.log.join('\n') || 'Nothing logged yet.'}</pre>
				{/if}
			</article>
		{/each}
	</div>
{/if}

<style>
	.page-head {
		margin-bottom: var(--space-5);
	}
	.page-head p {
		margin: var(--space-2) 0 0;
	}

	.task {
		padding: var(--space-4);
		margin-top: 0;
	}

	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-4);
		flex-wrap: wrap;
	}

	.head .row {
		align-items: flex-start;
	}

	.head h2 {
		font-size: 1rem;
	}

	.head p {
		margin: 0;
	}

	.bar {
		margin: var(--space-3) 0;
	}

	.meta {
		margin: var(--space-2) 0 0;
	}

	.log {
		margin-top: var(--space-3);
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-3);
		max-height: 20rem;
		overflow: auto;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		white-space: pre-wrap;
	}
</style>
