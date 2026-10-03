<script lang="ts">
	import { enhance } from '$app/forms';
	import Flash from '$lib/components/Flash.svelte';
	import RestartFields from '$lib/components/RestartFields.svelte';
	import ConsoleFields from '$lib/components/ConsoleFields.svelte';
	import PropertyInput from '$lib/components/PropertyInput.svelte';

	let { data, form } = $props();

	// Local state re-synced from `data` after every save; one-way bindings miss
	// post-save updates (see CLAUDE.md, "UI pitfalls").
	type Values = {
		memoryMode: 'auto' | 'fixed';
		memoryMaxMb: number;
		memoryMinMb: number;
		jvmPreset: string;
		restarts: typeof data.defaults.restarts;
		console: typeof data.defaults.console;
		values: Record<string, string>;
		checks: Record<string, boolean>;
	};
	function fromData(): Values {
		const d = data.defaults;
		const values: Record<string, string> = {};
		const checks: Record<string, boolean> = {};
		for (const { fields } of data.propertyGroups) {
			for (const field of fields) {
				if (field.type === 'boolean') checks[field.key] = d.properties[field.key] === 'true';
				else values[field.key] = d.properties[field.key] ?? '';
			}
		}
		return {
			memoryMode: d.memoryMaxMb === null ? 'auto' : 'fixed',
			memoryMaxMb: d.memoryMaxMb ?? data.suggestedMaxMb,
			memoryMinMb: d.memoryMinMb,
			jvmPreset: d.jvmPreset,
			restarts: { ...d.restarts },
			console: { ...d.console },
			values,
			checks
		};
	}
	// svelte-ignore state_referenced_locally
	let v = $state(fromData());
	$effect(() => {
		v = fromData();
	});

	const preset = $derived(data.presets.find((p) => p.id === v.jvmPreset));

	function keepValues() {
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
		};
	}
</script>

<svelte:head><title>New server defaults - MineShell</title></svelte:head>

<p class="muted"><a href="/settings">Settings</a> /</p>
<h1>New server defaults</h1>
<p class="muted intro">
	What a server starts with when you add it. Existing servers keep their own settings; change
	those on each server's settings page.
</p>

<Flash {form} />

<form method="POST" action="?/save" use:enhance={keepValues}>
	<section class="panel">
		<h2>Memory and Java</h2>
		<fieldset>
			<legend>Maximum memory</legend>
			<div class="check field">
				<input id="memoryAuto" type="radio" name="memoryMode" value="auto" bind:group={v.memoryMode} />
				<label for="memoryAuto">
					Automatic: {data.suggestedMaxMb} MB on this machine (its RAM minus 2 GB, at most 16 GB)
				</label>
			</div>
			<div class="check field">
				<input id="memoryFixed" type="radio" name="memoryMode" value="fixed" bind:group={v.memoryMode} />
				<label for="memoryFixed">A fixed amount</label>
			</div>
			{#if v.memoryMode === 'fixed'}
				<div class="field narrow">
					<label for="memoryMaxMb">Maximum memory (MB)</label>
					<input id="memoryMaxMb" name="memoryMaxMb" type="number" min="512" step="256" bind:value={v.memoryMaxMb} />
				</div>
			{/if}
			<p class="hint">Either way, the add-a-server form lets you change it for that server.</p>
		</fieldset>

		<div class="grid-2">
			<div class="field">
				<label for="memoryMinMb">Starting memory (MB)</label>
				<input id="memoryMinMb" name="memoryMinMb" type="number" min="256" step="256" bind:value={v.memoryMinMb} />
			</div>
			<div class="field">
				<label for="jvmPreset">JVM flags preset</label>
				<select id="jvmPreset" name="jvmPreset" bind:value={v.jvmPreset}>
					{#each data.presets as p (p.id)}
						<option value={p.id}>{p.name}</option>
					{/each}
				</select>
				{#if preset?.description}<p class="hint">{preset.description}</p>{/if}
			</div>
		</div>
	</section>

	<section class="panel">
		<h2>Restarts</h2>
		<RestartFields bind:values={v.restarts} />
	</section>

	<section class="panel">
		<h2>Console</h2>
		<ConsoleFields bind:values={v.console} />
	</section>

	<section class="panel">
		<h2>Game settings</h2>
		<p class="muted">
			Written to a new server's <code>server.properties</code>. A modpack that ships its own file
			keeps its values; these only fill in what it leaves out.
		</p>
		{#each data.propertyGroups as section (section.group)}
			<h3>{section.group}</h3>
			<div class="fields">
				{#each section.fields as field (field.key)}
					<div class="field">
						{#if field.type === 'boolean'}
							<PropertyInput {field} bind:checked={v.checks[field.key]} />
						{:else}
							<PropertyInput {field} bind:value={v.values[field.key]} />
						{/if}
					</div>
				{/each}
			</div>
		{/each}
	</section>

	<div class="button-row">
		<button class="button-primary" type="submit">Save defaults</button>
	</div>
</form>

<form method="POST" action="?/reset" use:enhance class="reset">
	<button class="button-quiet" type="submit">Reset everything to the built-in defaults</button>
</form>

<style>
	.intro {
		margin-bottom: var(--space-4);
	}

	.narrow {
		max-width: 16rem;
	}

	h3 {
		margin: var(--space-4) 0 var(--space-2);
		font-size: 0.95rem;
	}

	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: var(--space-2) var(--space-4);
	}

	.reset {
		margin-top: var(--space-3);
	}
</style>
