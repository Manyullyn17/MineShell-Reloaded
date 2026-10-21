<script lang="ts">
	import MapFrame from '#lib/components/MapFrame.svelte';

	// Reset to the root layout, which shows it without the rail: the whole window is the map.
	let { data } = $props();
</script>

<svelte:head>
	<title>Map of {data.name}</title>
</svelte:head>

<MapFrame src={data.src} title="Map of {data.name}" full />
