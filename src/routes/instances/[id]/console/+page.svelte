<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import Console from '#lib/components/Console.svelte';

	let { data } = $props();

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
				void refreshAll();
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

<Console
	instanceId={data.instance.id}
	bufferLines={data.bufferLines}
	canSend={data.running}
	resetKey={consoleGeneration}
	macros={data.macros}
/>
