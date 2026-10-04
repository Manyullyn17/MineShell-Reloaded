<script lang="ts">
	import Flash from '#lib/components/Flash.svelte';
	let { data, form } = $props();
</script>

<svelte:head><title>Set up MineShell</title></svelte:head>

<div class="card panel">
	<h1>Set up MineShell</h1>
	<p class="muted">
		Pick a password for this control panel. It is the only account, and it is what stands between
		your servers and anything else on the network.
	</p>

	{#if form?.message}
		<Flash message={form.message} type="error" />
	{/if}

	<form method="POST">
		<div class="field">
			<label for="password">Password</label>
			<!-- svelte-ignore a11y_autofocus -->
			<input id="password" name="password" type="password" minlength="8" autofocus required />
			<p class="hint">At least 8 characters.</p>
		</div>
		<div class="field">
			<label for="confirm">Password again</label>
			<input id="confirm" name="confirm" type="password" minlength="8" required />
		</div>
		<button class="button-primary" type="submit" style="width: 100%">Save and continue</button>
	</form>

	<dl class="env">
		<dt>Data directory</dt>
		<dd class="mono">{data.dataDir}</dd>
		<dt>systemd</dt>
		<dd>
			{#if data.systemd.available}
				<span class="mono">{data.scope} scope</span>
				{#if !data.unitInstalled}
					<span class="tag warn">unit file not installed yet</span>
				{/if}
			{:else}
				<span class="tag bad">not reachable</span> {data.systemd.message}
			{/if}
		</dd>
	</dl>
</div>

<style>
	.card {
		width: min(30rem, 100%);
	}
	h1 {
		margin-bottom: var(--space-2);
	}
	p {
		margin-bottom: var(--space-5);
	}
	.env {
		margin: var(--space-5) 0 0;
		padding-top: var(--space-4);
		border-top: 1px solid var(--line);
		font-size: 0.85rem;
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--space-1) var(--space-4);
	}
	dt {
		color: var(--text-faint);
	}
	dd {
		margin: 0;
	}
</style>
