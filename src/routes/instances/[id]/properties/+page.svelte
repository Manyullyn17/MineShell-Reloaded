<script lang="ts">
	import { enhance } from '$app/forms';
	import Flash from '$lib/components/Flash.svelte';

	let { data, form } = $props();

	let showRaw = $state(false);

	// Plain one-way value={...}/checked={...} bindings on <select> and
	// checkboxes did not pick up a fresh save until switching tabs and back -
	// confirmed here and on the instance settings page, both built the same
	// way. bind:value/bind:checked against local state that re-syncs
	// whenever `data` changes (the pattern the JVM preset picker on settings
	// already used, and which never showed the bug) fixes it.
	// The $effect below keeps this current - this initial read is deliberate.
	// svelte-ignore state_referenced_locally
	let rawValue = $state(data.raw);
	let fieldValues = $state<Record<string, string>>({});
	let fieldChecks = $state<Record<string, boolean>>({});
	$effect(() => {
		rawValue = data.raw;
		const values: Record<string, string> = {};
		const checks: Record<string, boolean> = {};
		for (const field of data.schema) {
			if (field.type === 'boolean') checks[field.key] = data.values[field.key] === 'true';
			else values[field.key] = data.values[field.key] ?? '';
		}
		for (const extra of data.extras) values[`extra:${extra.key}`] = extra.value;
		fieldValues = values;
		fieldChecks = checks;
	});

	// use:enhance's default success handling includes form.reset(), which
	// reverts every field in the form to its hydration-time default - for a
	// form editing existing values (as opposed to one that's adding a new
	// item) that's a brief, visible flash back to blank/default before the
	// effect above re-syncs everything to the actual saved values a moment
	// later. Keeping every other default behaviour, just not that part.
	function keepValues() {
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
		};
	}

	const grouped = $derived(
		data.groups
			.map((group) => ({ group, fields: data.schema.filter((f) => f.group === group) }))
			.filter((g) => g.fields.length > 0)
	);
</script>

<Flash {form} />

{#if data.running}
	<div class="notice info">
		<p>The server is running. Changes are written now but only take effect after a restart.</p>
	</div>
{/if}

<div class="switcher">
	<button class:active={!showRaw} onclick={() => (showRaw = false)}>Guided</button>
	<button class:active={showRaw} onclick={() => (showRaw = true)}>Raw file</button>
</div>

{#if showRaw}
	<form class="panel" method="POST" action="?/saveRaw" use:enhance={keepValues}>
		<div class="panel-head">
			<div>
				<h2>server.properties</h2>
				<p>Anything you write here is saved as-is. Comments and ordering are not preserved.</p>
			</div>
		</div>
		<textarea name="raw" rows="24" spellcheck="false" class="mono" bind:value={rawValue}></textarea>
		<div class="button-row save-row">
			<button class="button-primary" type="submit">Save file</button>
		</div>
	</form>
{:else}
	<form method="POST" action="?/save" use:enhance={keepValues}>
		{#each grouped as section (section.group)}
			<section class="panel">
				<h2>{section.group}</h2>
				<div class="fields">
					{#each section.fields as field (field.key)}
						<div class="field" class:wide={field.type === 'textarea'}>
							{#if field.type === 'boolean'}
								<input type="hidden" name={`present:${field.key}`} value="1" />
								<div class="check">
									<input
										id={field.key}
										name={field.key}
										type="checkbox"
										bind:checked={fieldChecks[field.key]}
									/>
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
									<select id={field.key} name={field.key} bind:value={fieldValues[field.key]}>
										{#each field.options ?? [] as option (option.value)}
											<option value={option.value}>{option.label}</option>
										{/each}
									</select>
								{:else if field.type === 'textarea'}
									<textarea id={field.key} name={field.key} rows="2" bind:value={fieldValues[field.key]}
									></textarea>
								{:else if field.type === 'number'}
									<input
										id={field.key}
										name={field.key}
										type="number"
										min={field.min}
										max={field.max}
										bind:value={fieldValues[field.key]}
									/>
								{:else}
									<input id={field.key} name={field.key} type="text" bind:value={fieldValues[field.key]} />
								{/if}
							{/if}
							{#if field.help}
								<p class="hint">{field.help}</p>
							{/if}
						</div>
					{/each}
				</div>
			</section>
		{/each}

		{#if data.extras.length}
			<section class="panel">
				<div class="panel-head">
					<div>
						<h2>Other keys</h2>
						<p>
							Keys MineShell has no dedicated control for, usually added by a mod or the pack.
							They are kept exactly as written.
						</p>
					</div>
				</div>
				<div class="fields">
					{#each data.extras as extra (extra.key)}
						<div class="field">
							<label for={`extra-${extra.key}`}>{extra.key}</label>
							<input
								id={`extra-${extra.key}`}
								name={`extra:${extra.key}`}
								type="text"
								bind:value={fieldValues[`extra:${extra.key}`]}
							/>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<div class="button-row save-row">
			<button class="button-primary" type="submit">Save changes</button>
		</div>
	</form>
{/if}

<style>
	.switcher {
		display: inline-flex;
		gap: 0;
		margin-bottom: var(--space-4);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
		overflow: hidden;
	}

	.switcher button {
		border: 0;
		border-radius: 0;
		background: transparent;
		color: var(--text-muted);
	}

	.switcher button.active {
		background: var(--panel-raised);
		color: var(--text);
	}

	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: var(--space-4);
	}

	.fields .field {
		margin-bottom: 0;
	}

	.fields .wide {
		grid-column: 1 / -1;
	}

	label .tag {
		margin-left: var(--space-2);
	}

	textarea.mono {
		font-family: var(--font-mono);
		font-size: 0.8rem;
	}

	.save-row {
		position: sticky;
		bottom: 0;
		padding: var(--space-3) 0;
		background: linear-gradient(to top, var(--bg) 60%, transparent);
	}
</style>
