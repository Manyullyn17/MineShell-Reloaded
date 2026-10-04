<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import Console from '$lib/components/Console.svelte';
	import Flash from '$lib/components/Flash.svelte';

	let { data, form } = $props();

	// This page used to poll invalidateAll() on a timer, which re-rendered the
	// whole console on a fixed cadence whether or not anything had changed.
	// The stats stream already pushes state, so reload only on a real
	// transition (started, stopped, crashed) and leave the console alone
	// otherwise.
	let consoleGeneration = $state(0);
	$effect(() => {
		const source = new EventSource(`/api/instances/${data.instance.id}/stats`);
		let last: string | null = null;

		source.addEventListener('state', (event) => {
			const payload = JSON.parse((event as MessageEvent).data);
			const key = `${payload.active}/${payload.sub}`;
			if (last !== null && last !== key) {
				void invalidateAll();
				// A restart goes through this same transition on its way back
				// up - clearing here, rather than waiting for "running" again,
				// means the view is already empty before the new process's
				// first line arrives instead of clearing a moment late.
				if (payload.sub !== 'running') consoleGeneration++;
			}
			last = key;
		});

		return () => source.close();
	});
</script>

<Flash {form} />

<section class="panel">
	<div class="panel-head">
		<div>
			<h2>Console</h2>
			<p>
				Output is read from the systemd journal. Commands go out over RCON, so they work the same
				way an operator typing in-game would.
			</p>
		</div>
		<form method="POST" action="?/power" use:enhance>
			<div class="button-row">
				{#if data.running}
					<button name="verb" value="restart">Restart</button>
					<button class="button-danger" name="verb" value="stop">Stop</button>
				{:else}
					<button class="button-primary" name="verb" value="start">Start</button>
				{/if}
			</div>
		</form>
	</div>

	<Console
		instanceId={data.instance.id}
		bufferLines={data.bufferLines}
		canSend={data.running}
		resetKey={consoleGeneration}
		macros={data.macros}
	/>
</section>
