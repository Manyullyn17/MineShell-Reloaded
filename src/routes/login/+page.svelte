<script lang="ts">
	import Flash from '#lib/components/Flash.svelte';
	let { data, form } = $props();
</script>

<svelte:head><title>Sign in - MineShell</title></svelte:head>

<div class="card panel">
	<h1>MineShell</h1>
	<p class="muted">Enter the admin password to manage your servers.</p>

	{#if form?.message}
		<Flash message={form.message} type="error" />
	{/if}

	<form method="POST" action="?/login">
		<input type="hidden" name="next" value={data.next} />
		<div class="field">
			<label for="password">Password</label>
			<!-- svelte-ignore a11y_autofocus -->
			<input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
		</div>
		<button class="button-primary" type="submit" style="width: 100%">Sign in</button>
	</form>
</div>

<style>
	.card {
		width: min(24rem, 100%);
	}
	h1 {
		margin-bottom: var(--space-1);
	}
	p {
		margin-bottom: var(--space-5);
	}
</style>
