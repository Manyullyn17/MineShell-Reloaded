<script lang="ts">
	import { refreshAll } from '$app/navigation';

	/**
	 * Background installs finish while you are looking at some other page, so
	 * completion is announced globally rather than only inside the Activity
	 * view. Driven by the same task stream the Activity page uses.
	 *
	 * A finished install also changes what the current page should show (an
	 * instance leaving "provisioning", mods appearing), so a completion also
	 * triggers a reload of the page data.
	 */
	type Task = {
		id: string;
		label: string;
		instanceId: string | null;
		state: string;
		error: string | null;
	};

	type Toast = { id: string; label: string; tone: 'ok' | 'error'; message: string };

	let toasts = $state<Toast[]>([]);
	/** Task states already announced, so a reconnect does not re-announce them. */
	let seen = new Set<string>();
	let primed = false;

	function dismiss(id: string) {
		toasts = toasts.filter((t) => t.id !== id);
	}

	function announce(task: Task) {
		const tone = task.state === 'failed' ? 'error' : 'ok';
		const message =
			task.state === 'failed'
				? (task.error ?? 'Failed.')
				: task.state === 'cancelled'
					? 'Cancelled.'
					: 'Finished.';

		toasts = [...toasts, { id: task.id, label: task.label, tone, message }];
		// Errors stay until dismissed; successes clear themselves.
		if (tone === 'ok') setTimeout(() => dismiss(task.id), 8000);
	}

	$effect(() => {
		const source = new EventSource('/api/tasks?stream=1');

		source.addEventListener('tasks', (event) => {
			const tasks: Task[] = JSON.parse((event as MessageEvent).data);

			// The first payload is a snapshot of whatever already finished before
			// this page loaded; recording it without announcing avoids a burst of
			// stale toasts on every navigation.
			if (!primed) {
				for (const task of tasks) {
					if (task.state !== 'running') seen.add(task.id);
				}
				primed = true;
				return;
			}

			let finished = false;
			for (const task of tasks) {
				if (task.state === 'running' || seen.has(task.id)) continue;
				seen.add(task.id);
				announce(task);
				finished = true;
			}
			if (finished) void refreshAll();
		});

		return () => source.close();
	});
</script>

{#if toasts.length}
	<div class="toasts" role="status" aria-live="polite">
		{#each toasts as toast (toast.id)}
			<div class="toast" data-tone={toast.tone}>
				<div class="body">
					<strong>{toast.label}</strong>
					<span class="small">{toast.message}</span>
				</div>
				<a class="button button-quiet" href="/tasks">Details</a>
				<button class="close" onclick={() => dismiss(toast.id)} aria-label="Dismiss">×</button>
			</div>
		{/each}
	</div>
{/if}

<style>
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

	.toast[data-tone='error'] {
		border-left-color: var(--error);
	}

	.body {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1 1 auto;
	}

	.body span {
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
