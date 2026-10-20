<script lang="ts">
	/**
	 * How long before a scheduled stop players are warned in game: Off, 1, 5, 10
	 * or 15 minutes, the marks the warnings actually go out at. A stored window
	 * between marks shows as the mark it warns from (7 -> 5), which is what it does.
	 */
	import SegmentedChoice from './SegmentedChoice.svelte';
	import { WARN_CHOICES, warnChoice } from '#lib/shared/presets.js';

	let {
		name,
		value = $bindable(),
		labelledby
	}: {
		name: string;
		value: number;
		labelledby: string;
	} = $props();
</script>

<SegmentedChoice options={WARN_CHOICES} {name} {labelledby} bind:value={() => warnChoice(value), (v) => (value = Number(v))} />
