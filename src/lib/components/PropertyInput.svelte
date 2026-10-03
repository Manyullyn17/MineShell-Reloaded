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
		checked = $bindable()
	}: { field: Field; value?: string; checked?: boolean } = $props();
</script>

{#if field.type === 'boolean'}
	<input type="hidden" name={`present:${field.key}`} value="1" />
	<div class="check">
		<input id={field.key} name={field.key} type="checkbox" bind:checked />
		<label for={field.key}>{field.label}</label>
	</div>
{:else}
	<label for={field.key}>
		{field.label}
		{#if field.restartRequired}
			<span class="tag">restart</span>
		{/if}
	</label>
	{#if field.type === 'select'}
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
</style>
