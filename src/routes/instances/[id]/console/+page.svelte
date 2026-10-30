<script lang="ts">
	import { can } from '#lib/shared/access.js';
	import { refreshAll } from '$app/navigation';
	import Console from '#lib/components/Console.svelte';
	import { followKey } from '#lib/shared/follow.svelte.js';

	let { data } = $props();

	// This page used to poll invalidateAll() on a timer, which re-rendered the
	// whole console on a fixed cadence whether or not anything had changed.
	// The stats stream already pushes state, so reload only on a real
	// transition (started, stopped, crashed) and leave the console alone
	// otherwise. Opened once per server (followKey): reopened on each reload of the page's
	// data, it forgot the last state every 3 s while the server started.
	let consoleGeneration = $state(0);
	followKey(() => data.instance.id, (id) => {
		const source = new EventSource(`/api/instances/${id}/stats`);
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
	mayCommand={can(data.access, data.instance.id, 'console.command')}
	resetKey={consoleGeneration}
	macros={data.macros}
/>
