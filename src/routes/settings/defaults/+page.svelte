<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import Flash from '#lib/components/Flash.svelte';
	import RestartFields from '#lib/components/RestartFields.svelte';
	import ConsoleFields from '#lib/components/ConsoleFields.svelte';
	import UpdateCheckFields from '#lib/components/UpdateCheckFields.svelte';
	import PropertyInput from '#lib/components/PropertyInput.svelte';
	import SegmentedChoice from '#lib/components/SegmentedChoice.svelte';
	import MemoryInput from '#lib/components/MemoryInput.svelte';

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
		limitMemory: 'none' | 'auto';
		limitCpuPercent: number | string;
		updates: typeof data.defaults.updates;
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
			limitMemory: d.limits.memory,
			limitCpuPercent: d.limits.cpuPercent ?? '',
			updates: { ...d.updates },
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

<p class="muted intro">
	What a server starts with when you add it. Existing servers keep their own settings; change
	those in each server's Settings.
</p>

<Flash {form} />

<form method="POST" action="?/save" use:enhance={keepValues}>
	<section class="panel">
		<h2>Memory and Java</h2>
		<fieldset>
			<legend>Maximum memory</legend>
			<div class="field">
				<SegmentedChoice
					options={[
						{ value: 'auto', label: 'Automatic' },
						{ value: 'fixed', label: 'A fixed amount' }
					]}
					bind:value={v.memoryMode}
					name="memoryMode"
					label="Maximum memory"
				/>
				{#if v.memoryMode === 'auto'}
					<p class="hint">{data.suggestedMaxMb} MB on this machine: its RAM minus 2 GB, at most 16 GB.</p>
				{/if}
			</div>
			{#if v.memoryMode === 'fixed'}
				<div class="field narrow">
					<label for="memoryMaxMb">Maximum memory</label>
					<MemoryInput id="memoryMaxMb" name="memoryMaxMb" label="Maximum memory" machineMb={data.machineMemoryMb} bind:value={v.memoryMaxMb} />
				</div>
			{/if}
			<p class="hint">Either way, the add-a-server form lets you change it for that server.</p>
		</fieldset>

		<div class="grid-2">
			<div class="field">
				<label for="memoryMinMb">Starting memory</label>
				<MemoryInput id="memoryMinMb" name="memoryMinMb" label="Starting memory" minMb={256} machineMb={data.machineMemoryMb} bind:value={v.memoryMinMb} />
			</div>
			<div class="field">
				<label for="jvmPreset">JVM flags preset</label>
				<select id="jvmPreset" name="jvmPreset" bind:value={v.jvmPreset}>
					{#each data.presets as p (p.id)}
						<option value={p.id}>{p.name}</option>
					{/each}
				</select>
				{#if preset?.description}<p class="hint">{preset.description}</p>{/if}
				{#if preset?.minJava}<p class="hint">A new server whose Java is older than {preset.minJava} gets Aikar instead.</p>{/if}
			</div>
		</div>
	</section>

	<section class="panel">
		<h2>Resource limits</h2>
		<fieldset>
			<legend>Memory limit</legend>
			<div class="field">
				<SegmentedChoice
					options={[
						{ value: 'none', label: 'None' },
						{ value: 'auto', label: 'Automatic' }
					]}
					bind:value={v.limitMemory}
					name="limitMemory"
					label="Memory limit"
				/>
				{#if v.limitMemory === 'auto'}
					<p class="hint">The server's maximum memory plus 25% and 1 GB, for what Java needs beyond it.</p>
				{/if}
			</div>
			<p class="hint">
				Past its limit the kernel ends the server. Set when the server is added; a server's Settings change it later, and
				raising its maximum memory there means raising the limit first.
			</p>
		</fieldset>
		<div class="field narrow">
			<label for="limitCpuPercent">CPU limit (%)</label>
			<input
				id="limitCpuPercent"
				name="limitCpuPercent"
				type="number"
				min="10"
				max={data.maxCpuPercent}
				step="10"
				placeholder="No limit"
				bind:value={v.limitCpuPercent}
			/>
			<p class="hint">100% is one core; this machine has {data.maxCpuPercent}%.</p>
		</div>
	</section>

	<section class="panel">
		<h2>Update checks</h2>
		<p class="muted">
			A pack server is checked for newer pack versions, a server set up from a loader for newer loader builds. What is found
			shows on its overview.
		</p>
		<UpdateCheckFields bind:values={v.updates} mods />
		<p class="hint">
			Forge names no betas: for a Forge server, its recommended build counts as a release and newer builds as betas, and its
			Settings call them that.
		</p>
	</section>

	<section class="panel">
		<h2>Restarts</h2>
		<RestartFields bind:values={v.restarts} bootNote={data.bootNote} />
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
	/* The save button sat right against the settings box above it. */
	form > .button-row {
		margin-top: var(--space-4);
	}

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
