<script lang="ts">
	import { copyText } from '#lib/shared/clipboard.js';
	import type { Snippet } from 'svelte';

	/**
	 * A password MineShell made for someone (a new account, a reset), shown the
	 * one time it exists in readable form, with a way to copy it.
	 */
	let { username, password, children }: { username: string; password: string; children?: Snippet } = $props();
	let copied = $state<boolean | null>(null);

	async function copy() {
		copied = await copyText(password);
	}
</script>

<div class="notice success one-time" role="status">
	<p>One-time password for <strong>{username}</strong>. Give it to them now: it is not shown again.</p>
	<div class="secret-line">
		<code>{password}</code>
		<button type="button" class="button-quiet" onclick={copy}>{copied ? 'Copied' : copied === false ? 'Copy failed: select it' : 'Copy'}</button>
	</div>
	<p class="small">They pick their own password the first time they sign in.{#if children}{' '}{@render children()}{/if}</p>
</div>

<style>
	.one-time {
		margin-bottom: var(--space-4);
	}

	.secret-line {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin: var(--space-2) 0;
	}

	.secret-line code {
		font-size: 1.05rem;
		padding: var(--space-1) var(--space-2);
		user-select: all;
	}
</style>
