<script lang="ts">
	/**
	 * A CPU share in cores on a notched slider (half-core steps, a notch per core),
	 * the box beside it for any share from a tenth of a core. Posts percent of
	 * one core, as systemd's CPUQuota and the field it replaced: 2.5 cores = 250.
	 */
	import NotchedInput from './NotchedInput.svelte';

	let {
		id,
		name,
		value = $bindable(),
		label,
		cores
	}: {
		id: string;
		name: string;
		/** Percent of one core. */
		value: number | null;
		label: string;
		/** The machine's cores: the slider's end. */
		cores: number;
	} = $props();
</script>

<NotchedInput {id} {name} bind:value {label} unit="cores" scale={100} low={0.5} high={Math.max(1, cores)} step={0.5} boxMin={0.1} boxMax={cores} />
