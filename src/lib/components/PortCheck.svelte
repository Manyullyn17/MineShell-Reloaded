<script lang="ts">
	/**
	 * Under a port field in a server's Settings: whether the port typed is
	 * free, another MineShell server's (then how to make room: swap ports with
	 * it, or move it to the next free one, sent with the form as `name`), or
	 * held by something else on the machine.
	 */
	let {
		instanceId,
		field,
		value,
		current,
		name
	}: { instanceId: string; field: 'game' | 'rcon'; value: number | string | null; current: number; name: string } = $props();

	type Answer =
		| { valid: false }
		| { valid: true; other: { name: string; kind: 'game' | 'rcon'; swapTo: number; freeTo: number | null } | null; listening: boolean };

	let answer = $state<Answer | null>(null);
	let move = $state<'' | 'swap' | 'free'>('');
	const port = $derived(Number(value));

	$effect(() => {
		const p = port;
		move = '';
		answer = null;
		if (!p || p === current) return;
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/ports?port=${p}&field=${field}`, { signal: controller.signal });
				if (res.ok) answer = await res.json();
			} catch {
				/* replaced by a newer check, or offline: the save still checks */
			}
		}, 300);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});
	const kindLabel = (kind: 'game' | 'rcon') => (kind === 'game' ? 'game port' : 'RCON port');
</script>

<input type="hidden" {name} value={move} />
{#if answer && port !== current}
	{#if !answer.valid}
		<p class="port-note bad">Ports go from 1 to 65535.</p>
	{:else if answer.other}
		{@const other = answer.other}
		<div class="port-clash" role="group" aria-label="Port {port} is taken">
			<p><strong>{other.name}</strong> uses {port} as its {kindLabel(other.kind)}. To take it:</p>
			<label class="check">
				<input type="radio" value="swap" bind:group={move} />
				Swap: {other.name} gets {current}
			</label>
			{#if other.freeTo}
				<label class="check">
					<input type="radio" value="free" bind:group={move} />
					Move {other.name} to {other.freeTo}
				</label>
			{/if}
			{#if move}<p class="faint">Applied to both when you save; a running server keeps its old port until restarted.</p>{/if}
		</div>
	{:else if answer.listening}
		<p class="port-note warn">
			Something else on this machine listens on {port} (not a MineShell server). This server will not start on it while that runs.
		</p>
	{:else}
		<p class="port-note good">✓ Free</p>
	{/if}
{/if}

<style>
	.port-note {
		margin: 0.3rem 0 0;
		font-size: 0.82rem;
	}

	.good {
		color: var(--accent-hover);
	}

	.warn {
		color: var(--warning);
	}

	.bad {
		color: var(--error);
	}

	.port-clash {
		margin-top: 0.4rem;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--line);
		border-left: 3px solid var(--warning);
		border-radius: var(--radius);
		background: var(--bg-sunken);
		font-size: 0.85rem;
	}

	.port-clash p {
		margin: 0 0 0.3rem;
	}

	.port-clash strong {
		font-weight: 500;
	}

	.port-clash .check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0.15rem 0;
	}

	.port-clash .faint {
		margin: 0.3rem 0 0;
	}
</style>
