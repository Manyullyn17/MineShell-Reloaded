<script lang="ts">
	import { deserialize } from '$app/forms';
	import { refreshAll } from '$app/navigation';
	import { formatRelative } from '#lib/shared/format.js';
	import { dismissToast, holdToast, resumeToast, toast, toasts } from '#lib/shared/toasts.svelte.js';

	/**
	 * The top bar's notification center: what is running (with progress), what
	 * finished in the last half hour, and the toasts in the corner. Fed by the
	 * task stream, so it follows an install from any page.
	 *
	 * A finished task also changes what the current page shows (a server leaving
	 * "provisioning", mods appearing), so a completion reloads the page data.
	 */
	let { running: initialRunning = 0 }: { running?: number } = $props();

	type Task = {
		id: string;
		label: string;
		instanceId: string | null;
		state: 'running' | 'done' | 'failed' | 'cancelled';
		progress: number | null;
		step: string;
		error: string | null;
		startedAt: number;
		finishedAt: number | null;
	};

	const READ_KEY = 'mineshell.notifications.read';

	let tasks = $state<Task[] | null>(null);
	let open = $state(false);
	let read = $state<string[]>([]);
	let now = $state(Date.now());
	let root = $state<HTMLElement | null>(null);

	const runningTasks = $derived(tasks?.filter((t) => t.state === 'running') ?? []);
	const finishedTasks = $derived(tasks?.filter((t) => t.state !== 'running') ?? []);
	const running = $derived(tasks ? runningTasks.length : initialRunning);
	const unread = $derived(finishedTasks.filter((t) => !read.includes(t.id)));
	const unreadFailed = $derived(unread.some((t) => t.state === 'failed'));

	$effect(() => {
		try {
			const stored = JSON.parse(localStorage.getItem(READ_KEY) ?? '[]');
			if (Array.isArray(stored)) read = stored.filter((x) => typeof x === 'string');
		} catch {
			/* private window, or nothing stored */
		}
	});

	function markRead() {
		const ids = finishedTasks.map((t) => t.id);
		if (ids.every((id) => read.includes(id))) return;
		// Finished tasks are cleared after half an hour, so only theirs are worth keeping.
		read = [...new Set([...read, ...ids])].filter((id) => tasks?.some((t) => t.id === id));
		try {
			localStorage.setItem(READ_KEY, JSON.stringify(read));
		} catch {
			/* ignore */
		}
	}

	// Opening the panel reads what is in it; so does anything finishing while it is open.
	$effect(() => {
		if (open) markRead();
	});

	$effect(() => {
		if (!open) return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});

	function announce(task: Task) {
		const tone = task.state === 'failed' ? 'error' : 'ok';
		const message =
			task.state === 'failed' ? (task.error ?? 'Failed.') : task.state === 'cancelled' ? 'Cancelled.' : 'Finished.';
		// Errors stay until closed; the rest close themselves.
		toast({ id: task.id, tone, title: task.label, message, href: '/tasks' });
	}

	$effect(() => {
		const source = new EventSource('/api/tasks?stream=1&brief=1');
		/** Task states already announced, so a reconnect does not announce them again. */
		const seen = new Set<string>();
		let primed = false;

		source.addEventListener('tasks', (event) => {
			const list: Task[] = JSON.parse((event as MessageEvent).data);
			tasks = list;

			// The first payload holds whatever finished before this page loaded;
			// recording it without announcing avoids a burst of stale toasts.
			if (!primed) {
				for (const task of list) if (task.state !== 'running') seen.add(task.id);
				primed = true;
				return;
			}

			let finished = false;
			for (const task of list) {
				if (task.state === 'running' || seen.has(task.id)) continue;
				seen.add(task.id);
				if (!open) announce(task);
				finished = true;
			}
			if (finished) void refreshAll();
		});

		return () => source.close();
	});

	async function cancel(task: Task) {
		const body = new FormData();
		body.set('id', task.id);
		try {
			const res = await fetch('/tasks?/cancel', { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
			const outcome = deserialize(await res.text());
			const message = outcome.type === 'success' ? (outcome.data as { message?: string } | undefined)?.message : null;
			toast({ tone: message ? 'info' : 'error', title: task.label, message: message ?? 'Could not cancel it.' });
		} catch {
			toast({ tone: 'error', title: task.label, message: 'Could not reach MineShell.' });
		}
	}

	function onWindowPointer(event: PointerEvent) {
		if (open && root && !root.contains(event.target as Node)) open = false;
	}

	function onWindowKey(event: KeyboardEvent) {
		if (open && event.key === 'Escape') open = false;
	}

	const toneOf = (state: Task['state']) =>
		state === 'running' ? 'busy' : state === 'done' ? 'running' : state === 'failed' ? 'failed' : 'stopped';
	const ended = (task: Task) =>
		`${task.state === 'done' ? 'Finished' : task.state === 'failed' ? 'Failed' : 'Cancelled'} ${task.finishedAt && task.finishedAt <= now ? formatRelative(task.finishedAt) : 'just now'}`;
</script>

<svelte:window onpointerdown={onWindowPointer} onkeydown={onWindowKey} />

<div class="center" bind:this={root}>
	<button
		type="button"
		class="trigger"
		class:busy={running > 0}
		aria-expanded={open}
		aria-haspopup="true"
		onclick={() => (open = !open)}
	>
		{#if running > 0}
			<span class="dot busy"></span>
			{running} task{running === 1 ? '' : 's'} running
		{:else}
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
				<path
					d="M8 1.75a4 4 0 0 0-4 4v2.6L2.75 10.6v.9h10.5v-.9L12 8.35v-2.6a4 4 0 0 0-4-4ZM6.25 12.75a1.75 1.75 0 0 0 3.5 0"
					fill="none"
					stroke="currentColor"
					stroke-width="1.3"
					stroke-linejoin="round"
				/>
			</svg>
			<span class="visually-hidden">Notifications</span>
		{/if}
		{#if unread.length}
			<span class="badge-count" class:failed={unreadFailed} title="{unread.length} finished since you last looked">
				{unread.length}
			</span>
		{/if}
	</button>

	{#if open}
		<div class="panel-pop" role="dialog" aria-label="Notifications">
			<div class="pop-head">
				<strong>Activity</strong>
				<a href="/tasks" onclick={() => (open = false)}>Details and logs</a>
			</div>

			{#if !tasks}
				<p class="empty-note">Connecting...</p>
			{:else if tasks.length === 0}
				<p class="empty-note">
					Nothing has run in the last half hour. Installs, pack changes, snapshots and downloads show up here.
				</p>
			{:else}
				<ul>
					{#each [...runningTasks, ...finishedTasks] as task (task.id)}
						<li class:running={task.state === 'running'}>
							<span class="dot {toneOf(task.state)}"></span>
							<div class="body">
								<div class="title">
									{#if task.instanceId}
										<a href="/instances/{task.instanceId}" onclick={() => (open = false)}>{task.label}</a>
									{:else}
										{task.label}
									{/if}
								</div>
								{#if task.state === 'running'}
									<div class="step small">
										<span class="muted">{task.step}</span>
										{#if task.progress !== null}<span class="faint">{task.progress}%</span>{/if}
									</div>
									<div class="progress" role="progressbar" aria-valuenow={task.progress ?? undefined}>
										<span class:indeterminate={task.progress === null} style="width: {task.progress ?? 100}%"></span>
									</div>
								{:else}
									{#if task.error}<p class="error-text small">{task.error}</p>{/if}
									<div class="small faint">{ended(task)}</div>
								{/if}
							</div>
							{#if task.state === 'running'}
								<button type="button" class="button-quiet button-danger cancel" onclick={() => cancel(task)}>Cancel</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

{#if toasts.length}
	<div class="toasts" role="status" aria-live="polite">
		{#each toasts as t (t.id)}
			<div
				class="toast"
				data-tone={t.tone}
				role="presentation"
				onmouseenter={() => holdToast(t.id)}
				onmouseleave={() => resumeToast(t.id)}
			>
				<div class="toast-body">
					{#if t.title}<strong>{t.title}</strong>{/if}
					<span class="small">{t.message}</span>
				</div>
				{#if t.href}<a class="button button-quiet" href={t.href} onclick={() => dismissToast(t.id)}>Details</a>{/if}
				<button type="button" class="close" onclick={() => dismissToast(t.id)} aria-label="Dismiss">×</button>
			</div>
		{/each}
	</div>
{/if}

<style>
	.center {
		position: relative;
	}

	.trigger {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: 0.85rem;
		color: var(--text-muted);
		padding: 0.3rem 0.55rem;
		border: 0;
		border-radius: var(--radius);
		background: var(--panel-raised);
	}

	.trigger.busy {
		padding: 0.25rem 0.65rem;
	}

	.trigger:hover,
	.trigger[aria-expanded='true'] {
		color: var(--text);
	}

	.trigger svg {
		display: block;
	}

	.badge-count {
		min-width: 1.05rem;
		height: 1.05rem;
		padding: 0 0.25rem;
		border-radius: 999px;
		background: var(--accent);
		color: var(--bg);
		font-size: 0.68rem;
		font-weight: 700;
		line-height: 1.05rem;
		text-align: center;
	}

	.trigger:not(.busy) .badge-count {
		position: absolute;
		top: -0.35rem;
		right: -0.4rem;
	}

	.badge-count.failed {
		background: var(--error);
	}

	.panel-pop {
		position: absolute;
		top: calc(100% + 0.5rem);
		right: 0;
		z-index: 50;
		width: min(25rem, calc(100vw - 2rem));
		max-height: min(32rem, calc(100vh - 5rem));
		overflow-y: auto;
		background: var(--panel-raised);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-lg);
		box-shadow: 0 12px 32px rgb(0 0 0 / 0.35);
	}

	.pop-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--line);
		position: sticky;
		top: 0;
		background: var(--panel-raised);
	}

	.pop-head a {
		font-size: 0.82rem;
	}

	.empty-note {
		margin: 0;
		padding: var(--space-4);
		font-size: 0.88rem;
		color: var(--text-muted);
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
	}

	li + li {
		border-top: 1px solid var(--line);
	}

	li .dot {
		margin-top: 0.4rem;
	}

	.body {
		flex: 1 1 auto;
		min-width: 0;
	}

	.title {
		font-size: 0.9rem;
		font-weight: 500;
		overflow-wrap: anywhere;
	}

	.title a {
		color: var(--text);
		text-decoration: none;
	}

	.title a:hover {
		text-decoration: underline;
	}

	.step {
		display: flex;
		justify-content: space-between;
		gap: var(--space-2);
		margin: 0.15rem 0 0.4rem;
	}

	.step .muted {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.error-text {
		margin: 0.15rem 0;
		color: var(--error);
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.cancel {
		font-size: 0.8rem;
		padding: 0.15rem 0.5rem;
	}

	.toasts {
		position: fixed;
		right: var(--space-4);
		bottom: var(--space-4);
		z-index: 60;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		max-width: min(26rem, calc(100vw - var(--space-5)));
	}

	.toast {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		background: var(--panel-raised);
		border: 1px solid var(--line-strong);
		border-left-width: 3px;
		border-radius: var(--radius);
		padding: var(--space-3);
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
	}

	.toast[data-tone='ok'] {
		border-left-color: var(--accent);
	}

	.toast[data-tone='info'] {
		border-left-color: var(--info);
	}

	.toast[data-tone='error'] {
		border-left-color: var(--error);
	}

	.toast-body {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1 1 auto;
	}

	.toast-body span {
		color: var(--text-muted);
	}

	.close {
		background: none;
		border: 0;
		color: var(--text-faint);
		font-size: 1.1rem;
		line-height: 1;
		padding: 0 0.25rem;
	}

	.close:hover {
		color: var(--text);
	}
</style>
