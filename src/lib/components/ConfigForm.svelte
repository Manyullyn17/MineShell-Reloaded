<script lang="ts">
	import { checkField, readConfig, writeField, ConfigFormError, type ConfigField, type ConfigFormat, type FieldInput, type ParsedConfig } from '#lib/shared/configform.js';

	/**
	 * A mod config's settings as a form (configform.ts). Each change rewrites that one value in
	 * the text and hands the whole text back (`onchange`): the Files editor holds it, so saving,
	 * undo and earlier versions work as for the text. `saved` is the file as on disk, to mark
	 * what is changed and not saved yet.
	 */
	let {
		format,
		text,
		saved,
		onchange
	}: { format: ConfigFormat; text: string; saved: string; onchange: (text: string) => void } = $props();

	const read = (t: string): ParsedConfig | ConfigFormError => {
		try {
			return readConfig(format, t);
		} catch (err) {
			return err instanceof ConfigFormError ? err : new ConfigFormError(err instanceof Error ? err.message : 'It could not be read.');
		}
	};
	const parsed = $derived(read(text));
	const savedValues = $derived.by(() => {
		const before = read(saved);
		const values = new Map<string, string>();
		if (!(before instanceof ConfigFormError)) for (const s of before.sections) for (const f of s.fields) values.set(f.id, JSON.stringify(f.value));
		return values;
	});

	let filter = $state('');
	/** Why the last value typed into a setting was not taken, by field id. */
	let problems = $state<Record<string, string>>({});

	const needle = $derived(filter.trim().toLowerCase());
	const shown = $derived.by(() => {
		if (parsed instanceof ConfigFormError) return [];
		return parsed.sections
			.map((section, index) => ({
				...section,
				index,
				fields: needle
					? section.fields.filter((f) => f.key.toLowerCase().includes(needle) || f.hint.toLowerCase().includes(needle) || section.title.toLowerCase().includes(needle))
					: section.fields
			}))
			.filter((s) => s.fields.length);
	});

	function apply(field: ConfigField, input: FieldInput) {
		const problem = checkField(format, field, input);
		if (problem) {
			problems = { ...problems, [field.id]: problem };
			return;
		}
		const { [field.id]: _, ...rest } = problems;
		problems = rest;
		onchange(writeField(text, format, field, input));
	}

	const listItems = (value: string) =>
		value
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);

	/** Java's own limits of a type (int, long, float, double) say nothing: left out, still checked. */
	const typeLimit = (n: number | undefined) => n === undefined || Math.abs(n) >= 2147483647;
	function limits(field: ConfigField): string {
		const parts: string[] = [];
		const min = typeLimit(field.min) ? undefined : field.min;
		const max = typeLimit(field.max) ? undefined : field.max;
		// Double.MIN_VALUE: the smallest number above 0.
		if (min === Number.MIN_VALUE) parts.push(max === undefined ? 'more than 0' : `more than 0, up to ${max}`);
		else if (min !== undefined && max !== undefined) parts.push(`${min} to ${max}`);
		else if (min !== undefined) parts.push(`at least ${min}`);
		else if (max !== undefined) parts.push(`at most ${max}`);
		if (field.defaultText !== undefined && field.defaultText !== '') parts.push(`default ${field.defaultText}`);
		return parts.join(' · ');
	}

	const changed = (field: ConfigField) => savedValues.size > 0 && savedValues.get(field.id) !== JSON.stringify(field.value);
	const domId = (field: ConfigField) => `cfg-${encodeURIComponent(field.id).replace(/%/g, '_')}`;
</script>

{#if parsed instanceof ConfigFormError}
	<div class="notice warning">
		<p>The form cannot show this file: {parsed.message} Edit it as text.</p>
	</div>
{:else}
	<div class="config-form">
		<div class="form-head">
			<input
				type="search"
				class="filter"
				placeholder="Find a setting"
				aria-label="Find a setting"
				autocomplete="off"
				bind:value={filter}
			/>
			<span class="faint small">{parsed.count} setting{parsed.count === 1 ? '' : 's'}</span>
		</div>
		{#if !needle && shown.length > 4}
			<nav class="jump small" aria-label="Sections">
				{#each shown as section (section.id)}
					<a href="#cfg-section-{section.index}">{section.title}</a>
				{/each}
			</nav>
		{/if}
		{#if !shown.length}
			<p class="muted">No setting matches “{filter}”.</p>
		{/if}
		{#each shown as section (section.id)}
			<section class="cfg-section" id="cfg-section-{section.index}">
				{#if section.id !== '' || parsed.sections.length > 1}
					<h3 class="mono">{section.title}</h3>
				{/if}
				{#if section.hint}<p class="hint faint small">{section.hint}</p>{/if}
				{#each section.fields as field (field.id)}
					{@const id = domId(field)}
					{@const problem = problems[field.id]}
					<div class="setting" class:changed={changed(field)}>
						<div class="about">
							<label class="key mono" for={id}>{field.key}</label>
							{#if changed(field)}<span class="tag">not saved</span>{/if}
							{#if field.hint}<p class="hint faint small">{field.hint}</p>{/if}
						</div>
						<div class="control">
							{#if field.kind === 'boolean'}
								<input {id} type="checkbox" class="switch" role="switch" checked={field.value === true} onchange={(e) => apply(field, e.currentTarget.checked)} />
							{:else if field.choices?.length && (field.kind === 'string' || field.choices.includes(String(field.value)))}
								<select {id} value={String(field.value)} onchange={(e) => apply(field, e.currentTarget.value)}>
									{#if !field.choices.includes(String(field.value))}<option value={String(field.value)}>{field.value} (not allowed)</option>{/if}
									{#each field.choices as choice (choice)}<option value={choice}>{choice}</option>{/each}
								</select>
							{:else if field.kind === 'integer' || field.kind === 'float'}
								<input
									{id}
									class="mono"
									inputmode={field.kind === 'integer' ? 'numeric' : 'decimal'}
									autocomplete="off"
									value={field.value}
									aria-invalid={problem ? 'true' : undefined}
									onchange={(e) => apply(field, e.currentTarget.value)}
								/>
							{:else if field.kind === 'list'}
								<textarea
									{id}
									class="mono"
									autocomplete="off"
									spellcheck="false"
									rows={Math.min(Math.max((field.value as string[]).length + 1, 2), 10)}
									value={(field.value as string[]).join('\n')}
									aria-invalid={problem ? 'true' : undefined}
									onchange={(e) => apply(field, listItems(e.currentTarget.value))}
								></textarea>
								<span class="faint small">One per line.</span>
							{:else if field.kind === 'raw' || String(field.value).includes('\n')}
								<textarea
									{id}
									class="mono"
									autocomplete="off"
									spellcheck="false"
									rows={Math.min(Math.max(String(field.value).split('\n').length, 2), 10)}
									value={String(field.value)}
									aria-invalid={problem ? 'true' : undefined}
									onchange={(e) => apply(field, e.currentTarget.value)}
								></textarea>
								{#if field.kind === 'raw'}<span class="faint small">As written in the file.</span>{/if}
							{:else}
								<input
									{id}
									class="mono"
									autocomplete="off"
									spellcheck="false"
									value={String(field.value)}
									aria-invalid={problem ? 'true' : undefined}
									onchange={(e) => apply(field, e.currentTarget.value)}
								/>
							{/if}
							{#if limits(field)}<span class="faint small">{limits(field)}</span>{/if}
							{#if problem}<span class="warn-text small" role="alert">{problem}</span>{/if}
						</div>
					</div>
				{/each}
			</section>
		{/each}
	</div>
{/if}

<style>
	.config-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.form-head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.filter {
		flex: 1 1 14rem;
		max-width: 24rem;
	}
	.jump {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-3);
		min-width: 0;
	}
	.jump a {
		overflow-wrap: anywhere;
	}
	.cfg-section {
		display: flex;
		flex-direction: column;
		scroll-margin-top: 6rem;
	}
	.cfg-section h3 {
		font-size: 0.95rem;
		margin: 0 0 var(--space-1);
		overflow-wrap: anywhere;
	}
	.hint {
		white-space: pre-line;
		margin: 0;
		overflow-wrap: anywhere;
	}
	.setting {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 20rem);
		gap: var(--space-1) var(--space-4);
		padding: var(--space-2) 0;
		border-top: 1px solid var(--line);
	}
	.setting.changed .key {
		color: var(--accent);
	}
	.about {
		min-width: 0;
	}
	.key {
		font-weight: 600;
		overflow-wrap: anywhere;
		margin-right: var(--space-1);
	}
	.control {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		min-width: 0;
	}
	.control input:not([type='checkbox']),
	.control select,
	.control textarea {
		width: 100%;
	}
	@media (max-width: 60rem) {
		.setting {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
