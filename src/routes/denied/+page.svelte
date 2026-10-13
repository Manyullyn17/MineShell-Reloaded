<script lang="ts">
	let { data } = $props();
</script>

<svelte:head><title>No access - MineShell</title></svelte:head>

<section class="panel denied">
	<h1>No access</h1>
	{#if data.unlisted}
		<p>MineShell has no access rule for <code>{data.from}</code>, so nobody may open it.</p>
	{:else}
		<p>Your account may not open <code>{data.from}</code>. Ask the owner or an admin of MineShell if you need it.</p>
	{/if}
	<p><a href="/">Back to the servers</a></p>
</section>

<style>
	.denied {
		max-width: 36rem;
	}

	.denied p {
		margin-top: var(--space-3);
	}
</style>
