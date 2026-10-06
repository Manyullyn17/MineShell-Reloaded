<script lang="ts">
	/**
	 * One guided server.properties field: a server's own properties page and
	 * the new-server defaults. A checkbox posts a `present:` marker so "off"
	 * can be told apart from "not on the form" (see propertiesFromForm).
	 */
	type Field = {
		key: string;
		label: string;
		help?: string;
		type: 'text' | 'number' | 'boolean' | 'select' | 'textarea';
		options?: { value: string; label: string }[];
		min?: number;
		max?: number;
		restartRequired?: boolean;
	};
	let {
		field,
		value = $bindable(),
		checked = $bindable(),
		segmented = false
	}: {
		field: Field;
		value?: string;
		checked?: boolean;
		/** A short choice (difficulty, game mode) as a row of buttons instead of a select. */
		segmented?: boolean;
	} = $props();

	// Long labels (operator levels) would make a row wider than the column; those stay a select.
	const asButtons = $derived(
		segmented &&
			field.type === 'select' &&
			(field.options?.length ?? 0) <= 4 &&
			(field.options ?? []).reduce((n, o) => n + o.label.length, 0) <= 40
	);
</script>

{#if field.type === 'boolean'}
	<input type="hidden" name={`present:${field.key}`} value="1" />
	<div class="check">
		<input id={field.key} name={field.key} type="checkbox" bind:checked />
		<label for={field.key}>{field.label}</label>
	</div>
{:else}
	<label for={field.key} id="{field.key}-label">
		{field.label}
		{#if field.restartRequired}
			<span class="tag">restart</span>
		{/if}
	</label>
	{#if asButtons}
		<div class="control segmented" role="radiogroup" aria-labelledby="{field.key}-label">
			{#each field.options ?? [] as option (option.value)}
				<label class:on={value === option.value}>
					<input type="radio" name={field.key} value={option.value} bind:group={value} />
					{option.label}
				</label>
			{/each}
		</div>
	{:else if field.type === 'select'}
		<select id={field.key} name={field.key} bind:value>
			{#each field.options ?? [] as option (option.value)}
				<option value={option.value}>{option.label}</option>
			{/each}
		</select>
	{:else if field.type === 'textarea'}
		<textarea id={field.key} name={field.key} rows="2" bind:value></textarea>
	{:else if field.type === 'number'}
		<input
			id={field.key}
			name={field.key}
			type="number"
			min={field.min}
			max={field.max}
			bind:value
		/>
	{:else}
		<input id={field.key} name={field.key} type="text" bind:value />
	{/if}
{/if}
{#if field.help}
	<p class="hint">{field.help}</p>
{/if}

<style>
	label .tag {
		margin-left: var(--space-2);
	}

	.segmented {
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		background: var(--bg-sunken);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
	}

	.segmented label {
		margin: 0;
		padding: 0.25rem 0.7rem;
		border-radius: 3px;
		font-size: 0.85rem;
		color: var(--text-muted);
		cursor: pointer;
		white-space: nowrap;
	}

	.segmented label.on {
		background: var(--line-strong);
		color: var(--text);
	}

	.segmented label:has(input:focus-visible) {
		outline: 2px solid var(--accent-hover);
	}

	.segmented input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
</style>
