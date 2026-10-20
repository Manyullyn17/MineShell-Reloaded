<script lang="ts">
	/**
	 * A number picked from fixed choices (lib/shared/presets.ts). A saved value
	 * that is not one of them (set before the field had choices, or by hand) is
	 * offered too, labelled by `other`, so opening and saving the form never
	 * changes it unasked.
	 */
	import type { Preset } from '#lib/shared/presets.js';

	let {
		id,
		name,
		value = $bindable(),
		choices,
		other,
		label,
		form
	}: {
		id?: string;
		name: string;
		value: number | null;
		choices: Preset[];
		other: (value: number) => string;
		/** For screen readers, when no <label for> names it. */
		label?: string;
		form?: string;
	} = $props();

	const options = $derived(
		value === null || choices.some((c) => c.value === value) ? choices : [...choices, { value, label: other(value) }].sort((a, b) => a.value - b.value)
	);
</script>

<select {id} {name} {form} aria-label={label} bind:value={() => String(value ?? ''), (v) => (value = Number(v))}>
	{#each options as option (option.value)}
		<option value={String(option.value)}>{option.label}</option>
	{/each}
</select>
