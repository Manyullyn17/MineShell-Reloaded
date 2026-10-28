<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import Flash from '#lib/components/Flash.svelte';
	import RestartFields from '#lib/components/RestartFields.svelte';
	import ConsoleFields from '#lib/components/ConsoleFields.svelte';
	import SnapshotScheduleFields from '#lib/components/SnapshotScheduleFields.svelte';
	import UpdateCheckFields from '#lib/components/UpdateCheckFields.svelte';
	import PropertyInput from '#lib/components/PropertyInput.svelte';
	import SegmentedChoice from '#lib/components/SegmentedChoice.svelte';
	import MemoryInput from '#lib/components/MemoryInput.svelte';
	import CpuInput from '#lib/components/CpuInput.svelte';
	import SettingsSection, { provideSettingsView } from '#lib/components/SettingsSection.svelte';
	import SaveBar from '#lib/components/SaveBar.svelte';
	import { formatGb } from '#lib/shared/memorylimit.js';

	let { data, form } = $props();

	// The rows of a server's Settings, every section shown: these are the settings a new server starts with.
	provideSettingsView({ tab: 'defaults', query: '', tabLabel: () => '' });

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
		snapshots: {
			snapshotEvery: string;
			snapshotDailyTime: string;
			snapshotIntervalHours: number;
			snapshotWhileRunning: string;
			snapshotWarnMinutes: number;
			snapshotSkipIdle: boolean;
		};
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
			snapshots: {
				snapshotEvery: d.snapshots.every,
				snapshotDailyTime: d.snapshots.dailyTime,
				snapshotIntervalHours: d.snapshots.intervalHours,
				snapshotWhileRunning: d.snapshots.whileRunning,
				snapshotWarnMinutes: d.snapshots.warnMinutes,
				snapshotSkipIdle: d.snapshots.skipIdle
			},
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

	// ---- what changed since the last save, as on a server's Settings
	const saved = $derived(fromData());
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	const changedProperty = (key: string) => (key in v.checks ? v.checks[key] !== saved.checks[key] : v.values[key] !== saved.values[key]);
	const sections = $derived([
		{
			label: 'Memory and Java',
			dirty:
				v.memoryMode !== saved.memoryMode ||
				(v.memoryMode === 'fixed' && v.memoryMaxMb !== saved.memoryMaxMb) ||
				v.memoryMinMb !== saved.memoryMinMb ||
				v.jvmPreset !== saved.jvmPreset
		},
		{ label: 'Resource limits', dirty: v.limitMemory !== saved.limitMemory || String(v.limitCpuPercent) !== String(saved.limitCpuPercent) },
		{ label: 'Update checks', dirty: !same(v.updates, saved.updates) },
		{ label: 'Restarts', dirty: !same(v.restarts, saved.restarts) },
		{ label: 'Scheduled snapshots', dirty: !same(v.snapshots, saved.snapshots) },
		{ label: 'Console', dirty: !same(v.console, saved.console) },
		{ label: 'Game settings', dirty: data.propertyGroups.some((g) => g.fields.some((f) => changedProperty(f.key))) }
	]);
	const dirty = $derived(sections.filter((s) => s.dirty));
	const isDirty = (label: string) => dirty.some((s) => s.label === label);

	let saving = $state(false);
	function keepValues() {
		saving = true;
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			saving = false;
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
	<div class="sections">
	<SettingsSection tab="defaults" title="Memory and Java" dirty={isDirty('Memory and Java')}>
		<div class="rows">
			<div class="field">
				<span class="label" id="memoryModeLabel">Maximum memory</span>
				<div class="control">
					<SegmentedChoice
						options={[
							{ value: 'auto', label: 'Automatic' },
							{ value: 'fixed', label: 'A fixed amount' }
						]}
						bind:value={v.memoryMode}
						name="memoryMode"
						labelledby="memoryModeLabel"
					/>
				</div>
				<p class="hint">
					{#if v.memoryMode === 'auto'}{formatGb(data.suggestedMaxMb)} on this machine: 8 GB, or its RAM minus 2 GB if that is less.{/if}
					Either way, the add-a-server form lets you change it for that server.
				</p>
			</div>
			{#if v.memoryMode === 'fixed'}
				<div class="field">
					<label for="memoryMaxMb">Amount</label>
					<MemoryInput id="memoryMaxMb" name="memoryMaxMb" label="Maximum memory" machineMb={data.machineMemoryMb} bind:value={v.memoryMaxMb} />
				</div>
			{/if}
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
	</SettingsSection>

	<SettingsSection tab="defaults" title="Resource limits" dirty={isDirty('Resource limits')}>
		<div class="rows">
			<div class="field">
				<span class="label" id="limitMemoryLabel">Memory limit</span>
				<div class="control">
					<SegmentedChoice
						options={[
							{ value: 'none', label: 'None' },
							{ value: 'auto', label: 'Automatic' }
						]}
						bind:value={v.limitMemory}
						name="limitMemory"
						labelledby="limitMemoryLabel"
					/>
				</div>
				<p class="hint">
					{#if v.limitMemory === 'auto'}The server's maximum memory plus 25% and 1 GB, for what Java needs beyond it.{/if}
					Past its limit the kernel ends the server. Set when the server is added; a server's Settings change it later, and raising
					its maximum memory there means raising the limit first.
				</p>
			</div>
			<div class="field">
				<span class="label" id="limitCpuLabel">CPU limit</span>
				<div class="control limit-control">
					<SegmentedChoice
						options={[
							{ value: 'none', label: 'None' },
							{ value: 'limit', label: 'Limit' }
						]}
						bind:value={
							() => (v.limitCpuPercent === '' ? 'none' : 'limit'),
							(mode) => (v.limitCpuPercent = mode === 'none' ? '' : Math.max(1, Math.floor(data.cpuCores / 2)) * 100)
						}
						name="limitCpuMode"
						labelledby="limitCpuLabel"
					/>
					{#if v.limitCpuPercent === ''}
						<input type="hidden" name="limitCpuPercent" value="" />
					{:else}
						<CpuInput
							id="limitCpuPercent"
							name="limitCpuPercent"
							label="CPU limit"
							cores={data.cpuCores}
							bind:value={() => Number(v.limitCpuPercent), (pct) => (v.limitCpuPercent = pct ?? '')}
						/>
					{/if}
				</div>
				<p class="hint">Past it the server is slowed down, not stopped; this machine has {data.cpuCores} cores.</p>
			</div>
		</div>
	</SettingsSection>

	<SettingsSection
		tab="defaults"
		title="Update checks"
		dirty={isDirty('Update checks')}
		description="A pack server is checked for newer pack versions, a server set up from a loader for newer loader builds. What is found shows on its overview."
	>
		<div class="rows">
			<UpdateCheckFields bind:values={v.updates} mods />
			<p class="faint small">
				Forge names no betas: for a Forge server, its recommended build counts as a release and newer builds as betas, and its
				Settings call them that.
			</p>
		</div>
	</SettingsSection>

	<SettingsSection tab="defaults" title="Restarts" dirty={isDirty('Restarts')}>
		<div class="rows">
			<RestartFields bind:values={v.restarts} bootNote={data.bootNote} />
		</div>
	</SettingsSection>

	<SettingsSection
		tab="defaults"
		title="Scheduled snapshots"
		dirty={isDirty('Scheduled snapshots')}
		description="A copy of the world on a schedule, kept by the snapshot settings under MineShell settings. Servers added before keep their own schedule."
	>
		<div class="rows">
			<SnapshotScheduleFields bind:values={v.snapshots} />
		</div>
	</SettingsSection>

	<SettingsSection tab="defaults" title="Console" dirty={isDirty('Console')}>
		<div class="rows">
			<ConsoleFields bind:values={v.console} />
		</div>
	</SettingsSection>

	<SettingsSection tab="defaults" title="Game settings" dirty={isDirty('Game settings')}>
		{#snippet description()}
			Written to a new server's <code>server.properties</code>. A modpack that ships its own file keeps its values; these only
			fill in what it leaves out.
		{/snippet}
		<div class="rows">
			{#each data.propertyGroups as section (section.group)}
				<fieldset>
					<legend>{section.group}</legend>
					{#each section.fields as field (field.key)}
						<div class="field" class:changed={changedProperty(field.key)}>
							{#if field.type === 'boolean'}
								<PropertyInput {field} bind:checked={v.checks[field.key]} />
							{:else}
								<PropertyInput {field} bind:value={v.values[field.key]} segmented />
							{/if}
						</div>
					{/each}
				</fieldset>
			{/each}
		</div>
	</SettingsSection>

	<div class="reset">
		<button class="button-quiet" type="submit" formaction="?/reset">Reset everything to the built-in defaults</button>
	</div>
	</div>

	<SaveBar changed={dirty.map((s) => s.label)} {saving} onDiscard={() => (v = fromData())} saveLabel="Save defaults" />
</form>

<style>
	.intro {
		margin-bottom: 0;
	}

	/* As wide as a server's Settings, so a control stays near its label; the save bar goes full width. */
	.sections {
		max-width: 54rem;
	}

	.reset {
		margin-top: var(--space-5);
	}
</style>
