<script lang="ts">
	/**
	 * On the sign-in and setup pages: a password typed here over plain http crosses the
	 * network readable. Known only in the browser (connection.ts), so nothing shows until then.
	 */
	import { connectionKind, REMOTE_ACCESS_DOCS, type Connection } from '#lib/shared/connection.js';

	/** On the sign-in page, which says where the warning is turned off. */
	let { canTurnOff = false }: { canTurnOff?: boolean } = $props();

	let connection = $state<Connection | null>(null);
	$effect(() => {
		connection = connectionKind(location);
	});
</script>

{#if connection === 'plain'}
	<div class="notice warning">
		<p class="small">
			Not encrypted: this page came over plain http, so the password you type crosses the network where anyone else on it
			could read it. On a home network you trust that may be fine; from anywhere else, reach MineShell through Tailscale
			or https (<a href={REMOTE_ACCESS_DOCS} target="_blank" rel="noreferrer">how</a>).
			{#if canTurnOff}This warning can be turned off under MineShell settings > System.{/if}
		</p>
	</div>
{/if}
