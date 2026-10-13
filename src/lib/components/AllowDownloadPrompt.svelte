<script lang="ts">
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import type { BlockedDownload } from '#lib/shared/downloads.js';

	/**
	 * Asks to allow downloads from an address MineShell refused (downloadaccess.ts),
	 * naming the address. Only the owner and global admins get the button; the
	 * server checks again (access policy).
	 */
	let {
		blocked,
		label = 'Allow downloads from this address',
		after = 'Allowed. Run it again to download.',
		onallowed
	}: {
		blocked: BlockedDownload;
		/** The button. */
		label?: string;
		/** Said once allowed, unless onallowed takes over. */
		after?: string;
		/** Runs once allowed (a retry); without it the page reloads its data. */
		onallowed?: () => void;
	} = $props();

	const mayAllow = $derived(!!page.data.access?.globalAdmin);
	let busy = $state(false);
	let allowed = $state(false);
	let problem = $state<string | null>(null);

	async function allow() {
		busy = true;
		problem = null;
		try {
			const res = await fetch('/api/downloads/allowed', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ address: blocked.address, host: blocked.host })
			});
			if (!res.ok) {
				problem = ((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? `Not allowed (${res.status}).`;
				return;
			}
			allowed = true;
			if (onallowed) onallowed();
			else await invalidateAll();
		} finally {
			busy = false;
		}
	}
</script>

<div class="notice warning allow-download">
	<p>
		{#if blocked.host === blocked.address}
			A download was refused: <code>{blocked.address}</code> is {blocked.kind}.
		{:else}
			A download was refused: <code>{blocked.host}</code> resolves to <code>{blocked.address}</code>, {blocked.kind}.
		{/if}
		MineShell does not download from addresses like that unless they are allowed, so a pack's links cannot reach
		services on this machine or your network.
	</p>
	{#if allowed}
		<p>{after}</p>
	{:else if mayAllow}
		<p>Allow it only if you know what is there and expect downloads from it.</p>
		<div class="button-row">
			<button type="button" onclick={allow} disabled={busy}>{label} (<span class="mono">{blocked.address}</span>)</button>
		</div>
		{#if problem}<p class="small error-text">{problem}</p>{/if}
	{:else}
		<p class="small muted">The owner or a global admin can allow this address.</p>
	{/if}
</div>

<style>
	.allow-download {
		margin: var(--space-3) 0;
	}

	.allow-download .button-row {
		margin: var(--space-2) 0;
	}

	.error-text {
		color: var(--error);
	}
</style>
