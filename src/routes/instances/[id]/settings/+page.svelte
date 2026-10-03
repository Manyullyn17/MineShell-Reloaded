<script lang="ts">
	import { enhance } from '$app/forms';
	import Flash from '$lib/components/Flash.svelte';
	import CleanroomOption from '$lib/components/CleanroomOption.svelte';
	import PackChangePanel from '$lib/components/PackChangePanel.svelte';
	import RestartFields from '$lib/components/RestartFields.svelte';
	import ConsoleFields from '$lib/components/ConsoleFields.svelte';
	import { CLEANMIX_WARNING, CLEANROOM_GUIDE_URL, usesCleanMix } from '$lib/shared/cleanroom';

	let { data, form } = $props();

	const s = $derived(data.settings);
	let showRcon = $state(false);
	let presetToApply = $state('');
	let presetName = $state('');
	let showSavePreset = $state(false);

	// Plain one-way value={...}/checked={...} bindings on <select> and
	// checkboxes did not pick up a fresh save until switching tabs and back -
	// this page used to work around it just for the restart-schedule select
	// (a scheduleOverride/lastSaved pair, now removed). bind:value/bind:checked
	// against local state that re-syncs whenever `data` changes - the same
	// pattern the JVM preset picker already used, and which never showed the
	// bug - fixes every field at once instead of needing a one-off per field.
	// The $effect below keeps every field current - this initial read is deliberate.
	// svelte-ignore state_referenced_locally
	let sv = $state({
		name: data.settings.name,
		minecraftVersion: data.settings.minecraftVersion,
		modloaderVersion: data.settings.modloaderVersion ?? '',
		javaPath: data.settings.javaPath ?? '',
		javaPathManual: data.settings.javaPath ?? '',
		memoryMaxMb: data.settings.memoryMaxMb,
		memoryMinMb: data.settings.memoryMinMb,
		jvmArgs: data.settings.jvmArgs,
		launchArgs: data.settings.launchArgs,
		serverPort: data.settings.serverPort,
		rconPort: data.settings.rconPort,
		autoRestartOnCrash: data.settings.autoRestartOnCrash,
		crashRestartLimit: data.settings.crashRestartLimit,
		crashRestartWindowSec: data.settings.crashRestartWindowSec,
		restartSchedule: data.settings.restartSchedule,
		restartIntervalHours: data.settings.restartIntervalHours,
		restartDailyTime: data.settings.restartDailyTime,
		restartWarnMinutes: data.settings.restartWarnMinutes,
		restartSkipIfPlayers: data.settings.restartSkipIfPlayers,
		consoleBacklogLines: data.settings.consoleBacklogLines,
		consoleBufferLines: data.settings.consoleBufferLines
	});
	$effect(() => {
		sv = {
			name: data.settings.name,
			minecraftVersion: data.settings.minecraftVersion,
			modloaderVersion: data.settings.modloaderVersion ?? '',
			javaPath: data.settings.javaPath ?? '',
			javaPathManual: data.settings.javaPath ?? '',
			memoryMaxMb: data.settings.memoryMaxMb,
			memoryMinMb: data.settings.memoryMinMb,
			jvmArgs: data.settings.jvmArgs,
			launchArgs: data.settings.launchArgs,
			serverPort: data.settings.serverPort,
			rconPort: data.settings.rconPort,
			autoRestartOnCrash: data.settings.autoRestartOnCrash,
			crashRestartLimit: data.settings.crashRestartLimit,
			crashRestartWindowSec: data.settings.crashRestartWindowSec,
			restartSchedule: data.settings.restartSchedule,
			restartIntervalHours: data.settings.restartIntervalHours,
			restartDailyTime: data.settings.restartDailyTime,
			restartWarnMinutes: data.settings.restartWarnMinutes,
			restartSkipIfPlayers: data.settings.restartSkipIfPlayers,
			consoleBacklogLines: data.settings.consoleBacklogLines,
			consoleBufferLines: data.settings.consoleBufferLines
		};
	});

	// use:enhance's default success handling includes form.reset(), which
	// reverts every field in the form to its hydration-time default - for a
	// form editing existing values that's a brief, visible flash back to
	// blank/default before the effect above re-syncs everything to the
	// actual saved values a moment later. Keeping every other default
	// behaviour, just not that part.
	function keepValues() {
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
		};
	}
</script>

<Flash {form} />

<section class="panel">
	<div class="panel-head">
		<div>
			<h2>Identity</h2>
			<p>
				The folder name and systemd unit are fixed at creation
				(<code class="mono">{data.instance.id}</code>), so renaming here only changes the display
				name. The Minecraft version records what is installed - changing it does not reinstall
				anything.
			</p>
		</div>
	</div>
	<form method="POST" action="?/general" use:enhance={keepValues}>
		<div class="grid-2">
			<div class="field">
				<label for="name">Display name</label>
				<input id="name" name="name" bind:value={sv.name} required />
			</div>
			<div class="field">
				<label for="minecraftVersion">Minecraft version</label>
				{#if data.minecraftVersions.length}
					<select id="minecraftVersion" name="minecraftVersion" bind:value={sv.minecraftVersion}>
						{#if !data.minecraftVersions.includes(sv.minecraftVersion)}
							<option value={sv.minecraftVersion}>{sv.minecraftVersion} (installed)</option>
						{/if}
						{#each data.minecraftVersions as version (version)}
							<option value={version}>{version}</option>
						{/each}
					</select>
				{:else}
					<input id="minecraftVersion" name="minecraftVersion" bind:value={sv.minecraftVersion} />
					<p class="hint">Mojang's version list was unreachable, so this is a plain field.</p>
				{/if}
				<p class="hint">Used to choose a Java runtime and to filter mod searches.</p>
			</div>
		</div>
		<button class="button-primary" type="submit">Save</button>
	</form>
</section>

{#if data.pack}
	<PackChangePanel instanceId={data.instance.id} pack={data.pack} running={data.running} />
{/if}

{#if data.settings.modloader !== 'vanilla'}
	<section class="panel">
		<div class="panel-head">
			<div>
				<h2>{data.instance.modloaderLabel} version</h2>
				<p>
					Installed: <strong>{data.settings.modloaderVersion ?? 'not recorded'}</strong>. Changing it
					reinstalls the loader in place; the world, configs and mods are left alone, and the current
					install is put back if the new one fails.
				</p>
			</div>
		</div>
		<form method="POST" action="?/loaderVersion" use:enhance={keepValues}>
			<div class="field">
				<label for="modloaderVersion">Version to install</label>
				{#if data.loaderVersions.length}
					<select id="modloaderVersion" name="modloaderVersion" bind:value={sv.modloaderVersion}>
						{#if sv.modloaderVersion && !data.loaderVersions.includes(sv.modloaderVersion)}
							<option value={sv.modloaderVersion}>{sv.modloaderVersion} (installed)</option>
						{/if}
						{#each data.loaderVersions.slice(0, 60) as version (version)}
							<option value={version}>
								{version}{version === data.settings.modloaderVersion ? ' (installed)' : ''}
							</option>
						{/each}
					</select>
				{:else}
					<input id="modloaderVersion" name="modloaderVersion" bind:value={sv.modloaderVersion} />
					<p class="hint">The version list was unreachable, so type the exact version.</p>
				{/if}
				{#if data.settings.modloader === 'cleanroom' && sv.modloaderVersion !== data.settings.modloaderVersion && usesCleanMix(sv.modloaderVersion || null)}
					<p class="hint warn-text">{CLEANMIX_WARNING}</p>
				{/if}
				{#if data.running}
					<p class="hint">Stop the server to change the loader version.</p>
				{/if}
			</div>
			<button
				type="submit"
				disabled={data.running || !sv.modloaderVersion || sv.modloaderVersion === data.settings.modloaderVersion}
			>
				Install this version
			</button>
		</form>
	</section>
{/if}

{#if data.cleanroom}
	{@const cr = data.cleanroom}
	<section class="panel">
		<div class="panel-head">
			<div>
				<h2>Cleanroom</h2>
				{#if cr.onCleanroom}
					<p>
						This server runs Cleanroom, a Forge 1.12.2 fork for modern Java.
						{#if cr.backupCreatedAt}
							The Forge install it replaced was kept on
							{new Date(cr.backupCreatedAt).toLocaleDateString()} and can be restored.
						{/if}
					</p>
				{:else}
					<p>
						Cleanroom is a Forge 1.12.2 fork for modern Java that loads the same mods, usually faster.
						Migrating moves the Forge files into <code>.mineshell/forge-backup</code>, so you can
						switch back here.
					</p>
				{/if}
			</div>
		</div>

		{#await data.cleanroomReport}
			<p class="muted small">Checking mods against Cleanroom's guide.</p>
		{:then report}
			{#if report}
				{@const missing = report.required.filter((r) => !r.present)}
				{#if report.disable.length || missing.length}
					<div class="report">
						<h3>{cr.onCleanroom ? 'Still needs fixing' : 'Migrating will'}</h3>
						<ul>
							{#each missing as mod (mod.label)}
								<li>Add <strong>{mod.label}</strong> <span class="muted">- {mod.reason}</span></li>
							{/each}
							{#each report.disable as item (item.fileName)}
								<li>
									Disable <strong>{item.label}</strong> <code>{item.fileName}</code>
									<span class="muted">- {item.reason}{item.replacement ? ` Use ${item.replacement} instead.` : ''}</span>
								</li>
							{/each}
						</ul>
					</div>
				{:else if cr.onCleanroom}
					<p class="muted small">Required mods are present and nothing on the guide's must-remove list is enabled.</p>
				{/if}
				{#if report.advise.length}
					<details class="report">
						<summary>
							{report.advise.length} more mod{report.advise.length === 1 ? '' : 's'} the guide suggests replacing (not changed automatically)
						</summary>
						<ul>
							{#each report.advise as item (item.fileName)}
								<li>
									<strong>{item.label}</strong> <code>{item.fileName}</code>
									{#if item.replacement}&rarr; {item.replacement}{/if}
									<span class="muted">- {item.reason}</span>
								</li>
							{/each}
						</ul>
						<p class="hint">
							Some of these swap content mods, which can affect existing worlds. See
							<a href={CLEANROOM_GUIDE_URL} target="_blank" rel="noreferrer">Cleanroom's guide</a>.
						</p>
					</details>
				{/if}
			{/if}
		{:catch}
			<p class="muted small">Could not read the mods folder.</p>
		{/await}

		{#if cr.running}
			<p class="hint">Stop the server to {cr.onCleanroom ? 'change' : 'migrate'} it.</p>
		{/if}

		{#if cr.onCleanroom}
			<div class="actions">
				<form method="POST" action="?/cleanroomFixes" use:enhance>
					<button type="submit" disabled={cr.running}>Apply required fixes</button>
				</form>
				{#if cr.backupCreatedAt}
					<form
						method="POST"
						action="?/revertForge"
						use:enhance={({ cancel }) => {
							if (!confirm('Put the Forge install back? Mods the migration disabled are re-enabled and Fugue/Scalar Legacy are removed.')) cancel();
						}}
					>
						<button type="submit" disabled={cr.running}>Revert to Forge</button>
					</form>
				{/if}
			</div>
		{:else}
			<form method="POST" action="?/migrateCleanroom" use:enhance>
				<CleanroomOption javaMajors={data.javaRuntimes.map((j) => j.majorVersion)} toggle={false} idPrefix="migrate-cleanroom" />
				<button class="button-primary" type="submit" disabled={cr.running}>Migrate to Cleanroom</button>
			</form>
		{/if}
	</section>
{/if}

<section class="panel">
	<div class="panel-head">
		<div>
			<h2>Runtime</h2>
			<p>
				{data.instance.modloaderLabel} on Minecraft {s.minecraftVersion} expects Java {data.requiredJava}. MineShell picks a matching
				runtime unless you pin one.
			</p>
		</div>
		<form method="POST" action="?/rescanJava" use:enhance>
			<button class="button-quiet" type="submit">Rescan for Java</button>
		</form>
	</div>

	{#if data.javaResolution.warning}
		<div class="notice warning"><p>{data.javaResolution.warning}</p></div>
	{/if}

	<form method="POST" action="?/runtime" use:enhance={keepValues}>
		<div class="field">
			<label for="javaPath">Java runtime</label>
			<select id="javaPath" name="javaPath" bind:value={sv.javaPath}>
				<option value="">
					Match automatically (currently {data.javaResolution.path ?? 'nothing installed'})
				</option>
				{#each data.javaRuntimes as java (java.path)}
					<option value={java.path}>Java {java.majorVersion} - {java.path}</option>
				{/each}
			</select>
			<p class="hint">
				Not listed? Type the full path to the <code>java</code> binary in the field below and it
				will be used as-is.
			</p>
		</div>

		<div class="field">
			<label for="javaPathManual">Or enter a path by hand</label>
			<input
				id="javaPathManual"
				name="javaPathManual"
				class="mono"
				placeholder="/usr/lib/jvm/java-21-openjdk/bin/java"
				bind:value={sv.javaPathManual}
			/>
		</div>

		<div class="grid-2">
			<div class="field">
				<label for="memoryMaxMb">Maximum memory (MB)</label>
				<input id="memoryMaxMb" name="memoryMaxMb" type="number" min="512" step="256" bind:value={sv.memoryMaxMb} />
			</div>
			<div class="field">
				<label for="memoryMinMb">Starting memory (MB)</label>
				<input id="memoryMinMb" name="memoryMinMb" type="number" min="256" step="256" bind:value={sv.memoryMinMb} />
			</div>
		</div>

		<div class="field">
			<label for="applyPreset">Flag preset</label>
			<div class="row preset-row">
				<select id="applyPreset" name="applyPreset" bind:value={presetToApply}>
					<option value="">Keep the current flags</option>
					{#each data.jvmPresets as preset (preset.id)}
						<option value={preset.id}>
							{preset.name}{preset.builtIn ? '' : ' (saved)'}
						</option>
					{/each}
				</select>
			</div>
			{#if presetToApply}
				{@const chosen = data.jvmPresets.find((p) => p.id === presetToApply)}
				{#if chosen}
					<p class="hint">{chosen.description}</p>
					<pre class="preset-preview mono">{chosen.flags || '(memory settings only)'}</pre>
					<p class="hint">
						Saving replaces the arguments below with this preset. Memory flags come from the
						fields above either way.
					</p>
				{/if}
			{/if}
		</div>

		<div class="field">
			<label for="jvmArgs">JVM arguments</label>
			<textarea
				id="jvmArgs"
				name="jvmArgs"
				rows="4"
				class="mono"
				spellcheck="false"
				disabled={Boolean(presetToApply)}
				bind:value={sv.jvmArgs}
			></textarea>
			<p class="hint">
				<code>-Xms</code> and <code>-Xmx</code> are rewritten from the memory fields above, so you
				do not have to keep them in sync.
			</p>
		</div>

		<details>
			<summary>Launch arguments</summary>
			<div class="field advanced">
				<label for="launchArgs">Arguments after the JVM options</label>
				<input id="launchArgs" name="launchArgs" class="mono" bind:value={sv.launchArgs} />
				<p class="hint">
					Written into the systemd unit environment as
					<code>MS_LAUNCH_ARGS</code>. Modern Forge and NeoForge use an <code>@argfile</code>
					here instead of a jar. Only change this if a loader install produced the wrong result.
				</p>
			</div>
		</details>

		<button class="button-primary" type="submit">Save runtime settings</button>
	</form>

	<div class="preset-tools">
		{#if showSavePreset}
			<form method="POST" action="?/savePreset" use:enhance class="row wrap">
				<input type="hidden" name="jvmArgs" value={sv.jvmArgs} />
				<div class="field grow">
					<label for="presetName">Preset name</label>
					<input id="presetName" name="presetName" bind:value={presetName} placeholder="My tuning" />
					<p class="hint">
						Saves the current flags (without <code>-Xms</code>/<code>-Xmx</code>) for reuse on any
						instance.
					</p>
				</div>
				<button class="button-primary" type="submit">Save preset</button>
				<button type="button" class="button-quiet" onclick={() => (showSavePreset = false)}>
					Cancel
				</button>
			</form>
		{:else}
			<button class="button-quiet" onclick={() => (showSavePreset = true)}>
				Save current flags as a preset
			</button>
		{/if}

		{#if data.jvmPresets.some((p) => !p.builtIn)}
			<ul class="saved-presets">
				{#each data.jvmPresets.filter((p) => !p.builtIn) as preset (preset.id)}
					<li>
						<span>{preset.name}</span>
						<form method="POST" action="?/deletePreset" use:enhance>
							<input type="hidden" name="presetId" value={preset.id} />
							<button class="button-quiet button-danger" type="submit">Delete</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>

<section class="panel">
	<h2>Network</h2>
	<form method="POST" action="?/network" use:enhance={keepValues}>
		<div class="grid-2">
			<div class="field">
				<label for="serverPort">Game port</label>
				<input id="serverPort" name="serverPort" type="number" min="1" max="65535" bind:value={sv.serverPort} />
			</div>
			<div class="field">
				<label for="rconPort">RCON port</label>
				<input id="rconPort" name="rconPort" type="number" min="1" max="65535" bind:value={sv.rconPort} />
				<p class="hint">Used by MineShell to send console commands. Do not expose it.</p>
			</div>
		</div>

		<div class="field">
			<span class="label-text">RCON password</span>
			<div class="row">
				<code class="secret">{showRcon ? (data.rconPassword ?? 'not set') : '••••••••••••'}</code>
				<button class="button-quiet" type="button" onclick={() => (showRcon = !showRcon)}>
					{showRcon ? 'Hide' : 'Show'}
				</button>
			</div>
			<p class="hint">Generated when the server was created and stored encrypted.</p>
		</div>

		<div class="check field">
			<input id="rotateRcon" name="rotateRcon" type="checkbox" />
			<label for="rotateRcon">Generate a new RCON password when saving</label>
		</div>

		<button class="button-primary" type="submit">Save network settings</button>
	</form>
</section>

<section class="panel">
	<h2>Restarts</h2>
	<form method="POST" action="?/restarts" use:enhance={keepValues}>
		<RestartFields bind:values={sv} />

		<button class="button-primary" type="submit">Save restart settings</button>
	</form>
</section>

<section class="panel">
	<h2>Console</h2>
	<form method="POST" action="?/console" use:enhance={keepValues}>
		<ConsoleFields bind:values={sv} />
		<button class="button-primary" type="submit">Save console preferences</button>
	</form>
</section>

<style>
	.warn-text {
		color: var(--warning);
	}

	.report {
		margin-bottom: var(--space-3);
	}

	.report h3 {
		font-size: 0.95rem;
		margin-bottom: var(--space-2);
	}

	.report ul {
		margin: 0 0 var(--space-2);
		padding-left: 1.2rem;
		font-size: 0.88rem;
	}

	.report li {
		margin-bottom: var(--space-1);
	}

	.actions {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.label-text {
		display: block;
		font-size: 0.85rem;
		color: var(--text-muted);
		margin-bottom: var(--space-1);
	}

	.secret {
		flex: 1 1 auto;
		overflow-wrap: anywhere;
		padding: 0.3rem 0.5rem;
	}

	details summary {
		cursor: pointer;
		color: var(--text-muted);
		font-size: 0.88rem;
		margin-bottom: var(--space-3);
	}

	.advanced {
		border-left: 2px solid var(--line);
		padding-left: var(--space-3);
	}

	textarea.mono,
	input.mono {
		font-family: var(--font-mono);
		font-size: 0.8rem;
	}

	textarea:disabled {
		opacity: 0.5;
	}

	.preset-row select {
		flex: 1 1 auto;
	}

	.preset-preview {
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
		margin: var(--space-2) 0 0;
		font-size: 0.75rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.preset-tools {
		margin-top: var(--space-4);
		padding-top: var(--space-4);
		border-top: 1px solid var(--line);
	}

	.preset-tools .grow {
		flex: 1 1 14rem;
		margin-bottom: 0;
	}

	.wrap {
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-3);
	}

	.saved-presets {
		list-style: none;
		margin: var(--space-3) 0 0;
		padding: 0;
		display: grid;
		gap: var(--space-1);
	}

	.saved-presets li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		font-size: 0.9rem;
		padding: var(--space-1) 0;
		border-bottom: 1px solid var(--line);
	}
</style>
