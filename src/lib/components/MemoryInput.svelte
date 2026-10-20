<script lang="ts">
	/**
	 * A memory amount in whole GB (1024 MB, as Java's -Xmx counts) on a notched
	 * slider, the box beside it for any amount; posts MB (NotchedInput). The
	 * slider runs from 1 GB (or the first whole GB `minMb` allows) to 16 GB (less
	 * on a machine with less RAM; `maxGb` sets another end), so each GB gets room.
	 */
	import NotchedInput from './NotchedInput.svelte';

	let {
		id,
		name,
		value = $bindable(),
		label,
		minMb = 512,
		machineMb,
		maxGb,
		form,
		oninput
	}: {
		id: string;
		name: string;
		/** MB. Null: nothing set; posted empty, so the action keeps its fallback. */
		value: number | null;
		label: string;
		minMb?: number;
		machineMb: number;
		/** The slider's end, in place of 16 GB: a memory limit or cap sits above the heaps. */
		maxGb?: number;
		form?: string;
		oninput?: () => void;
	} = $props();

	const GB = 1024;
</script>

<NotchedInput
	{id}
	{name}
	bind:value
	{label}
	unit="GB"
	scale={GB}
	low={Math.max(1, Math.ceil(minMb / GB))}
	high={maxGb ?? Math.min(16, Math.ceil(machineMb / GB))}
	boxMin={minMb / GB}
	{form}
	{oninput}
/>
