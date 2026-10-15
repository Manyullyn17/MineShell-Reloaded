<script lang="ts" generics="T extends string">
	/**
	 * A short choice as a row of buttons: radios in labels, so a form posts it
	 * as usual (`name`) and the keyboard moves through it like any radio group.
	 * Styles are `.segmented-choice` in app.css. Name the group with
	 * `labelledby` (the id of a visible label) or `label`.
	 */
	let {
		options,
		value = $bindable(),
		name,
		labelledby,
		label,
		disabled = false
	}: {
		options: readonly { value: T; label: string }[];
		value?: T;
		name?: string;
		labelledby?: string;
		label?: string;
		disabled?: boolean;
	} = $props();
</script>

<div class="segmented-choice" role="radiogroup" aria-labelledby={labelledby} aria-label={label} aria-disabled={disabled || undefined}>
	{#each options as option (option.value)}
		<label class:on={value === option.value}>
			<input type="radio" {name} value={option.value} bind:group={value} {disabled} />
			{option.label}
		</label>
	{/each}
</div>
