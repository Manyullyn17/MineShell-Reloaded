<script lang="ts">
	import { page } from '$app/stores';
</script>

<svelte:head><title>{$page.status} - MineShell</title></svelte:head>

<div class="panel wrap">
	<h1>{$page.status}</h1>
	<p class="muted">{$page.error?.message ?? 'Something went wrong.'}</p>
	<a class="button button-primary" href="/">Back to the server list</a>
</div>

<style>
	.wrap {
		max-width: 32rem;
		margin: var(--space-7) auto;
		text-align: center;
	}
	h1 {
		font-family: var(--font-mono);
		font-size: 2.5rem;
		color: var(--text-faint);
	}
	p {
		margin: var(--space-2) auto var(--space-5);
	}
</style>
