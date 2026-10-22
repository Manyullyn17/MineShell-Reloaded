<script lang="ts">
	import { can, type InstancePermission } from '#lib/shared/access.js';
	import { actionMessage, enhance, postAction } from '#lib/shared/forms.js';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import Flash from '#lib/components/Flash.svelte';
	import PackChangePanel from '#lib/components/PackChangePanel.svelte';
	import PackRollback from '#lib/components/PackRollback.svelte';
	import MigratePanel from '#lib/components/MigratePanel.svelte';
	import ConfigMergeReview from '#lib/components/ConfigMergeReview.svelte';
	import SnapshotChoice from '#lib/components/SnapshotChoice.svelte';
	import JavaPrompt from '#lib/components/JavaPrompt.svelte';
	import RestartFields from '#lib/components/RestartFields.svelte';
	import ConsoleFields from '#lib/components/ConsoleFields.svelte';
	import UpdateCheckFields from '#lib/components/UpdateCheckFields.svelte';
	import { channelNote } from '#lib/shared/updatecheck.js';
	import SnapshotPolicyFields from '#lib/components/SnapshotPolicyFields.svelte';
	import PropertyInput from '#lib/components/PropertyInput.svelte';
	import MemoryAdvice from '#lib/components/MemoryAdvice.svelte';
	import PortCheck from '#lib/components/PortCheck.svelte';
	import SettingsSection, { provideSettingsView } from '#lib/components/SettingsSection.svelte';
	import { formatBytes, formatDateTime } from '#lib/shared/format.js';
	import { CLEANMIX_WARNING, usesCleanMix } from '#lib/shared/cleanroom.js';
	import { streamed } from '#lib/shared/streamed.svelte.js';
	import { formatGb, minMemoryLimitMb, suggestedMemoryLimitMb, wholeGbAbove } from '#lib/shared/memorylimit.js';
	import MemoryInput from '#lib/components/MemoryInput.svelte';
	import SegmentedChoice from '#lib/components/SegmentedChoice.svelte';
	import PresetSelect from '#lib/components/PresetSelect.svelte';
	import WarnChoice from '#lib/components/WarnChoice.svelte';
	import CpuInput from '#lib/components/CpuInput.svelte';
	import { EVERY_HOURS, unevenHours } from '#lib/shared/presets.js';
	import { BACKUP_COPY_CHOICES } from '#lib/shared/backups.js';
	import IconSection from './IconSection.svelte';
	import CleanroomSection from './CleanroomSection.svelte';
	import CopyDeleteSection from './CopyDeleteSection.svelte';
	import PlayitSection from './PlayitSection.svelte';
	import PresetsSection from './PresetsSection.svelte';
	import CommandsSection from './CommandsSection.svelte';
	import NotificationsSection from './NotificationsSection.svelte';

	let { data, form } = $props();
	const LIMIT_MODES = [
		{ value: 'none', label: 'No limit' },
		{ value: 'limit', label: 'Limit' }
	] as const;

	/** What this account may do here; the server checks every action again. */
	const may = (permission: InstancePermission | 'admin') => can(data.access, data.instance.id, permission);
	// A copy has every file and makes its maker the copy's admin.
	const mayCopy = $derived(may('duplicate') && may('files') && data.access.canCreate);

	// Streamed: fetched from Mojang and the loader's servers the first time.
	// Until they arrive, the pickers hold only the installed version.
	const versions = streamed(() => data.versions, () => data.instance.id);
	const minecraftVersions = $derived(versions.ready ? versions.value?.minecraft : undefined);
	const loaderVersions = $derived(versions.ready ? versions.value?.loader : undefined);

	// ---- tabs and search

	const TABS = [
		{ id: 'general', label: 'General' },
		{ id: 'gameplay', label: 'Gameplay' },
		{ id: 'players', label: 'Players' },
		{ id: 'network', label: 'Network' },
		{ id: 'performance', label: 'Performance' },
		{ id: 'java', label: 'Java & memory' },
		{ id: 'automation', label: 'Automation' },
		{ id: 'snapshots', label: 'Snapshots' },
		{ id: 'advanced', label: 'Advanced' }
	];
	// The tab can come from a link (the World tab points at Snapshots).
	let tab = $state(TABS.some((t) => t.id === page.url.searchParams.get('tab')) ? page.url.searchParams.get('tab')! : 'general');
	let query = $state('');
	provideSettingsView({
		get tab() {
			return tab;
		},
		get query() {
			return query.trim();
		},
		tabLabel: (id) => TABS.find((t) => t.id === id)?.label ?? id
	});

	const s = $derived(data.settings);
	/** A limit applies to a running server at once, and that server has the heap it started with. */
	const limitHeapMb = $derived(Math.max(s.memoryMaxMb ?? 0, data.runningMemoryMaxMb ?? 0));

	// ---- field state
	//
	// Every field is bound to local state. When the page's data reloads (after
	// any action, a save or adding a scheduled command alike), only the fields
	// whose saved value changed are copied in, so unsaved edits elsewhere on
	// the page survive. The bind-to-local-state pattern itself is the one in
	// CLAUDE.md: one-way bindings missed post-save updates.

	function settingsValues() {
		const d = data.settings;
		return {
			name: d.name,
			minecraftVersion: d.minecraftVersion,
			modloaderVersion: d.modloaderVersion ?? '',
			javaPath: d.javaPath ?? '',
			javaPathManual: d.javaPath ?? '',
			memoryMaxMb: d.memoryMaxMb,
			memoryMinMb: d.memoryMinMb,
			jvmArgs: d.jvmArgs,
			launchArgs: d.launchArgs,
			serverPort: d.serverPort,
			rconPort: d.rconPort,
			autoRestartOnCrash: d.autoRestartOnCrash,
			crashRestartLimit: d.crashRestartLimit,
			crashRestartWindowSec: d.crashRestartWindowSec,
			restartSchedule: d.restartSchedule,
			restartIntervalHours: d.restartIntervalHours,
			restartDailyTime: d.restartDailyTime,
			restartWarnMinutes: d.restartWarnMinutes,
			restartSkipIfPlayers: d.restartSkipIfPlayers,
			bootStart: d.bootStart,
			consoleBacklogLines: d.consoleBacklogLines,
			consoleBufferLines: d.consoleBufferLines,
			updateCheck: d.updateCheck,
			updateCheckHours: d.updateCheckHours,
			updateChannel: d.updateChannel,
			modUpdateCheck: d.modUpdateCheck,
			limitMemoryMb: (d.limitMemoryMb ?? '') as number | string,
			limitCpuPercent: (d.limitCpuPercent ?? '') as number | string,
			snapshotEvery: d.snapshotEvery as string,
			snapshotDailyTime: d.snapshotDailyTime,
			snapshotIntervalHours: d.snapshotIntervalHours,
			snapshotWhileRunning: d.snapshotWhileRunning as string,
			snapshotWarnMinutes: d.snapshotWarnMinutes,
			snapshotSkipIdle: d.snapshotSkipIdle as boolean,
			voicePort: (d.voicePort ?? '') as number | string,
			backupDestination: d.backupDestination,
			backupCopy: d.backupCopy as string,
			backupKeep: d.backupKeep as number | string
		};
	}
	function propertyValues() {
		const values: Record<string, string> = {};
		for (const field of data.properties.schema) {
			if (field.type !== 'boolean') values[field.key] = data.properties.values[field.key] ?? '';
		}
		for (const extra of data.properties.extras) values[`extra:${extra.key}`] = extra.value;
		return values;
	}
	function propertyChecks() {
		const checks: Record<string, boolean> = {};
		for (const field of data.properties.schema) {
			if (field.type === 'boolean') checks[field.key] = data.properties.values[field.key] === 'true';
		}
		return checks;
	}
	const snapshotServerValues = () => ({ ...data.snapshotSettings.values });

	/** Copies what changed between two saved states into the edited one. */
	function syncChanged<T extends Record<string, unknown>>(edited: T, before: T, after: T) {
		for (const key of Object.keys(after) as (keyof T)[]) {
			if (before[key] !== after[key] || !(key in edited)) edited[key] = after[key];
		}
	}

	// The initial reads are deliberate; the effect below keeps them current.
	// svelte-ignore state_referenced_locally
	let sv = $state(settingsValues());

	// The overview's "Review update" link names the loader build to install.
	const offeredLoader = page.url.searchParams.get('loaderVersion');
	// svelte-ignore state_referenced_locally
	if (offeredLoader) sv.modloaderVersion = offeredLoader;
	// svelte-ignore state_referenced_locally
	let fieldValues = $state(propertyValues());
	// svelte-ignore state_referenced_locally
	let fieldChecks = $state(propertyChecks());
	// svelte-ignore state_referenced_locally
	let snapshotValues = $state(snapshotServerValues());
	// svelte-ignore state_referenced_locally
	let rawValue = $state(data.properties.raw);
	let saved = {
		sv: untrack(settingsValues),
		values: untrack(propertyValues),
		checks: untrack(propertyChecks),
		snapshot: untrack(snapshotServerValues),
		raw: untrack(() => data.properties.raw)
	};
	$effect(() => {
		const next = {
			sv: settingsValues(),
			values: propertyValues(),
			checks: propertyChecks(),
			snapshot: snapshotServerValues(),
			raw: data.properties.raw
		};
		untrack(() => {
			syncChanged(sv, saved.sv, next.sv);
			syncChanged(fieldValues, saved.values, next.values);
			syncChanged(fieldChecks, saved.checks, next.checks);
			syncChanged(snapshotValues, saved.snapshot, next.snapshot);
			if (saved.raw !== next.raw) rawValue = next.raw;
		});
		saved = next;
	});

	let rotateRcon = $state(false);
	/** The RCON password once Show asked for it; the page does not come with it. */
	let rconShown = $state<string | null>(null);
	$effect(() => {
		// A save may have generated a new one: hide the old.
		void data.settings;
		rconShown = null;
	});
	let presetToApply = $state('');
	// The preset the flags in the box are, ignoring order and the memory flags.
	const flagSet = (flags: string) =>
		flags
			.split(/\s+/)
			.filter((f) => f && !/^-Xm[sx]/.test(f))
			.sort()
			.join(' ');
	const currentPreset = $derived(data.jvmPresets.find((p) => flagSet(p.flags) === flagSet(sv.jvmArgs ?? '')) ?? null);

	// ---- server.properties, a section at a time

	const PROPERTY_SECTIONS: Record<string, string[]> = {
		motd: ['motd'],
		rules: ['difficulty', 'gamemode', 'force-gamemode', 'hardcore', 'allow-flight', 'spawn-monsters', 'enable-command-block'],
		world: ['level-name', 'level-seed', 'level-type', 'generate-structures', 'allow-nether', 'spawn-protection'],
		joining: ['max-players', 'white-list', 'enforce-whitelist', 'player-idle-timeout'],
		permissions: ['pvp', 'op-permission-level'],
		connection: ['server-ip', 'online-mode', 'enable-query'],
		distances: ['view-distance', 'simulation-distance', 'entity-broadcast-range-percentage'],
		ticking: ['max-tick-time', 'pause-when-empty-seconds', 'sync-chunk-writes', 'network-compression-threshold']
	};
	const placed = new Set(Object.values(PROPERTY_SECTIONS).flat());
	const fieldsOf = (section: string) =>
		PROPERTY_SECTIONS[section].map((key) => data.properties.schema.find((f) => f.key === key)).filter((f) => !!f);
	/** Keys with a typed control that no section above claims (a newer schema). */
	const unplaced = $derived(data.properties.schema.filter((f) => !placed.has(f.key)));

	const changedProperty = (key: string) => {
		const field = data.properties.schema.find((f) => f.key === key);
		if (!field) return false;
		return field.type === 'boolean'
			? fieldChecks[key] !== (data.properties.values[key] === 'true')
			: String(fieldValues[key] ?? '') !== String(data.properties.values[key] ?? '');
	};
	const differs = (a: unknown, b: unknown) => String(a ?? '') !== String(b ?? '');
	const svChanged = (...keys: (keyof ReturnType<typeof settingsValues>)[]) => {
		const base = settingsValues();
		return keys.some((k) => differs(sv[k], base[k]));
	};

	// ---- the save bar
	//
	// Each section is its own form, posting to the action that has always
	// saved it. Save submits the changed ones in turn and stops at the first
	// refusal, which then shows its tab.

	type Section = { id: string; tab: string; label: string; restart: boolean; dirty: () => boolean };
	const SECTIONS: Section[] = [
		{ id: 'identity', tab: 'general', label: 'Identity', restart: false, dirty: () => svChanged('name') },
		{ id: 'updates', tab: 'general', label: 'Update checks', restart: false, dirty: () => svChanged('updateCheck', 'updateCheckHours', 'updateChannel', 'modUpdateCheck') },
		{ id: 'motd', tab: 'general', label: 'Server description', restart: true, dirty: () => PROPERTY_SECTIONS.motd.some(changedProperty) },
		{ id: 'rules', tab: 'gameplay', label: 'Rules', restart: true, dirty: () => PROPERTY_SECTIONS.rules.some(changedProperty) },
		{ id: 'world', tab: 'gameplay', label: 'World', restart: true, dirty: () => PROPERTY_SECTIONS.world.some(changedProperty) },
		{ id: 'joining', tab: 'players', label: 'Joining', restart: true, dirty: () => PROPERTY_SECTIONS.joining.some(changedProperty) },
		{ id: 'permissions', tab: 'players', label: 'Permissions', restart: true, dirty: () => PROPERTY_SECTIONS.permissions.some(changedProperty) },
		{ id: 'port', tab: 'network', label: 'Game port', restart: true, dirty: () => svChanged('serverPort') },
		{ id: 'connection', tab: 'network', label: 'Connection', restart: true, dirty: () => PROPERTY_SECTIONS.connection.some(changedProperty) },
		{ id: 'rcon', tab: 'network', label: 'RCON', restart: true, dirty: () => svChanged('rconPort') || rotateRcon },
		{ id: 'voice', tab: 'network', label: 'Voice chat', restart: true, dirty: () => svChanged('voicePort') },
		{ id: 'distances', tab: 'performance', label: 'Distances', restart: true, dirty: () => PROPERTY_SECTIONS.distances.some(changedProperty) },
		{ id: 'ticking', tab: 'performance', label: 'Ticking and disk', restart: true, dirty: () => PROPERTY_SECTIONS.ticking.some(changedProperty) },
		{ id: 'limits', tab: 'performance', label: 'Resource limits', restart: false, dirty: () => svChanged('limitMemoryMb', 'limitCpuPercent') },
		{
			// Before launch: launch rebuilds the memory flags from what memory saved.
			id: 'memory',
			tab: 'java',
			label: 'Memory',
			restart: true,
			dirty: () => svChanged('memoryMaxMb', 'memoryMinMb')
		},
		{
			id: 'launch',
			tab: 'java',
			label: 'Java and JVM flags',
			restart: true,
			dirty: () => svChanged('javaPath', 'javaPathManual', 'jvmArgs', 'launchArgs') || !!presetToApply
		},
		{
			id: 'restarts',
			tab: 'automation',
			label: 'Restarts',
			restart: false,
			dirty: () =>
				svChanged(
					'autoRestartOnCrash',
					'crashRestartLimit',
					'crashRestartWindowSec',
					'restartSchedule',
					'restartIntervalHours',
					'restartDailyTime',
					'restartWarnMinutes',
					'restartSkipIfPlayers',
					'bootStart'
				)
		},
		{
			id: 'snapshotSchedule',
			tab: 'snapshots',
			label: 'Scheduled snapshots',
			restart: false,
			dirty: () => svChanged('snapshotEvery', 'snapshotDailyTime', 'snapshotIntervalHours', 'snapshotWhileRunning', 'snapshotWarnMinutes', 'snapshotSkipIdle')
		},
		{
			id: 'snapshots',
			tab: 'snapshots',
			label: 'Snapshots',
			restart: false,
			dirty: () => {
				const base = data.snapshotSettings.values;
				return (Object.keys(snapshotValues) as (keyof typeof snapshotValues)[]).some((k) => differs(snapshotValues[k], base[k]));
			}
		},
		{ id: 'backups', tab: 'snapshots', label: 'Backup copies', restart: false, dirty: () => svChanged('backupDestination', 'backupCopy', 'backupKeep') },
		{ id: 'console', tab: 'advanced', label: 'Console', restart: false, dirty: () => svChanged('consoleBacklogLines', 'consoleBufferLines') },
		{
			id: 'more',
			tab: 'advanced',
			label: 'Other keys',
			restart: true,
			dirty: () => unplaced.some((f) => changedProperty(f.key)) || data.properties.extras.some((e) => fieldValues[`extra:${e.key}`] !== e.value)
		}
	];
	let forms = $state<Record<string, HTMLFormElement | null>>({});
	const dirty = $derived(SECTIONS.filter((section) => forms[section.id] && section.dirty()));
	const dirtyIds = $derived(new Set(dirty.map((d) => d.id)));
	const dirtyTabs = $derived(new Set(dirty.map((d) => d.tab)));
	const needsRestart = $derived(data.running && dirty.some((d) => d.restart));

	let saving = $state(false);
	let message = $state<{ ok: boolean; message: string } | null>(null);

	async function toggleRcon() {
		if (rconShown !== null) {
			rconShown = null;
			return;
		}
		const result = await postAction('?/revealRcon', new FormData());
		rconShown = result.type === 'success' ? String((result.data as { password?: string | null } | undefined)?.password ?? 'not set') : 'could not be read';
	}

	async function save(restartAfter: boolean) {
		if (saving || !dirty.length) return;
		saving = true;
		message = null;
		const list = [...dirty];
		let done = 0;
		/** What a section's save did beyond saving (another server's port moved), shown after "Saved". */
		const notes: string[] = [];
		try {
			for (const section of list) {
				const formEl = forms[section.id];
				if (!formEl) continue;
				const result = await postAction(formEl.action, new FormData(formEl));
				if (result.type === 'failure' || result.type === 'error') {
					message = { ok: false, message: `${section.label}: ${actionMessage(result, 'Not saved.')}` };
					tab = section.tab;
					query = '';
					return;
				}
				if (result.type === 'success') notes.push(...((result.data as { notes?: string[] } | undefined)?.notes ?? []));
				if (section.id === 'rcon') rotateRcon = false;
				if (section.id === 'launch') presetToApply = '';
				done++;
			}
			if (restartAfter) {
				const body = new FormData();
				body.set('verb', 'restart');
				const result = await postAction(`/instances/${encodeURIComponent(data.instance.id)}?/power`, body);
				message =
					result.type === 'success'
						? { ok: true, message: [`Saved ${done} section${done === 1 ? '' : 's'}. Restarting the server.`, ...notes].join(' ') }
						: { ok: false, message: `Saved, but the restart failed: ${actionMessage(result, 'no answer')}` };
			} else {
				message = {
					ok: true,
					message: [needsRestart ? 'Saved. Restart the server for the changes marked restart to apply.' : 'Saved.', ...notes].join(' ')
				};
			}
		} finally {
			await invalidateAll();
			saving = false;
		}
	}

	function discard() {
		sv = settingsValues();
		fieldValues = propertyValues();
		fieldChecks = propertyChecks();
		snapshotValues = snapshotServerValues();
		rotateRcon = false;
		presetToApply = '';
		message = null;
	}

	/**
	 * Enter in a field saves everything, like the bar. A button that names its
	 * own action (Rescan for Java, Use the global settings) posts just that.
	 */
	async function onSectionSubmit(event: SubmitEvent) {
		event.preventDefault();
		const submitter = event.submitter as HTMLButtonElement | null;
		if (submitter?.hasAttribute('formaction') || submitter?.name) {
			const formEl = event.currentTarget as HTMLFormElement;
			// formAction is the page's URL when the button names no action of its own.
			const action = submitter.hasAttribute('formaction') ? submitter.formAction : formEl.action;
			const result = await postAction(action, new FormData(formEl, submitter));
			message = { ok: result.type === 'success', message: actionMessage(result, 'Done.') };
			await invalidateAll();
			return;
		}
		await save(false);
	}

	function keepValues() {
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
		};
	}
</script>

{#snippet propertyRows(section: string)}
	{#each fieldsOf(section) as field (field.key)}
		<div class="field" class:changed={changedProperty(field.key)}>
			{#if field.type === 'boolean'}
				<PropertyInput {field} bind:checked={fieldChecks[field.key]} />
			{:else}
				<PropertyInput {field} bind:value={fieldValues[field.key]} segmented />
			{/if}
		</div>
	{/each}
{/snippet}

{#snippet propertyForm(section: string)}
	<form method="POST" action="?/properties" class="rows" bind:this={forms[section]} onsubmit={onSectionSubmit}>
		{@render propertyRows(section)}
	</form>
{/snippet}

<div class="subhead">
	<nav class="subtabs" aria-label="Settings sections">
		{#each TABS as t, i (t.id)}
			{#if i === 5}<span class="sep" aria-hidden="true"></span>{/if}
			<button
				type="button"
				aria-current={!query.trim() && tab === t.id ? 'page' : undefined}
				onclick={() => {
					tab = t.id;
					query = '';
				}}
			>
				{t.label}{#if dirtyTabs.has(t.id)}<span class="badge">{dirty.filter((d) => d.tab === t.id).length}</span>{/if}
			</button>
		{/each}
	</nav>
	<span class="search">
		<span aria-hidden="true">⌕</span>
		<input type="search" bind:value={query} placeholder="Search all settings" aria-label="Search all settings" />
	</span>
</div>

<Flash {form} />
{#if message}<Flash form={message} />{/if}

<div class="settings">
	{#if data.running && !query.trim() && ['gameplay', 'players', 'network', 'performance', 'java'].includes(tab)}
		<div class="notice info running-note">
			<p>The server is running. Fields tagged <span class="tag warn">restart</span> are saved now but only take effect after a restart.</p>
		</div>
	{/if}

	<!-- ============================================================ General -->

	<SettingsSection tab="general" title="Identity" editable={may('settings.edit')} dirty={dirtyIds.has('identity') || dirtyIds.has('motd')}>
		{#snippet description()}
			The folder and systemd unit (<code class="mono">{data.instance.id}</code>) are fixed at creation, so renaming only changes
			the label.
		{/snippet}
		<form method="POST" action="?/general" class="rows" bind:this={forms.identity} onsubmit={onSectionSubmit}>
			<div class="field">
				<label for="name">Display name</label>
				<input id="name" name="name" bind:value={sv.name} required />
			</div>
		</form>
		{@render propertyForm('motd')}
	</SettingsSection>

	<IconSection instanceId={data.instance.id} hasIcon={data.hasIcon} packIcon={!!data.pack?.projectId} editable={may('settings.edit')} />

	{#if data.pack}
		<SettingsSection tab="general" id="modpack" title="Modpack" editable={may('software')} description="Change the pack version; the world and your own mods stay.">
			<div class="embedded">
				<PackChangePanel
					instanceId={data.instance.id}
					pack={data.pack}
					running={data.running}
					snapshotPrompt={data.snapshotPrompt}
					offeredVersionId={page.url.searchParams.get('packVersion')}
					{form}
				/>
				{#if data.packRollback}
					<PackRollback info={data.packRollback} running={data.running} snapshotPrompt={data.snapshotPrompt} {form} />
				{/if}
				{#if data.configMerge?.entries.length}
					<ConfigMergeReview instanceId={data.instance.id} report={data.configMerge} />
				{/if}
			</div>
		</SettingsSection>
		{@render updateChecks()}
	{/if}

	<!-- Pack servers move with their pack; Cleanroom has its own section below. -->
	{#if !data.pack && data.settings.modloader !== 'cleanroom'}
		<SettingsSection tab="general" title="Minecraft version and loader" editable={may('software')}>
			{#snippet description()}
				Runs <strong>{data.instance.modloaderLabel}{data.settings.modloader === 'vanilla' ? '' : ` ${data.settings.modloaderVersion ?? ''}`}</strong> on
				Minecraft <strong>{data.settings.minecraftVersion}</strong>. Moving to a newer Minecraft or another loader reinstalls the
				loader and moves every mod MineShell can look up to a build for it; mods without one are disabled. Configs and the world
				stay.
			{/snippet}
			<MigratePanel
				instanceId={data.instance.id}
				current={{ minecraft: data.settings.minecraftVersion, loader: data.settings.modloader, loaderVersion: data.settings.modloaderVersion }}
				{minecraftVersions}
				loaders={data.loaders}
				running={data.running}
				snapshotPrompt={data.snapshotPrompt}
				{form}
			/>
		</SettingsSection>
	{/if}

	{#if data.settings.modloader !== 'vanilla'}
		<SettingsSection tab="general" id="loader-version" title="{data.instance.modloaderLabel} version" editable={may('software')}>
			{#snippet description()}
				Installed: <strong>{data.settings.modloaderVersion ?? 'not recorded'}</strong>. Reinstalls the loader in place; the
				world, configs and mods are left alone, and the current install is put back if the new one fails.
			{/snippet}
			<form method="POST" action="?/loaderVersion" use:enhance={keepValues} class="block">
				<div class="inline-row">
					{#if !loaderVersions || loaderVersions.length}
						<select
							id="modloaderVersion"
							name="modloaderVersion"
							bind:value={sv.modloaderVersion}
							aria-label="Version to install"
							aria-busy={!loaderVersions}
						>
							{#if sv.modloaderVersion && !loaderVersions?.includes(sv.modloaderVersion)}
								<option value={sv.modloaderVersion}>{sv.modloaderVersion}{sv.modloaderVersion === data.settings.modloaderVersion ? ' (installed)' : ''}</option>
							{/if}
							{#each (loaderVersions ?? []).slice(0, 60) as version (version)}
								<option value={version}>{version}{version === data.settings.modloaderVersion ? ' (installed)' : ''}</option>
							{/each}
						</select>
					{:else}
						<input
							id="modloaderVersion"
							name="modloaderVersion"
							bind:value={sv.modloaderVersion}
							aria-label="Version to install"
							placeholder="The version list was unreachable; type the exact version"
						/>
					{/if}
					<button
						type="submit"
						disabled={data.running || !sv.modloaderVersion || sv.modloaderVersion === data.settings.modloaderVersion}
					>
						Install this version
					</button>
				</div>
				{#if data.settings.modloader === 'cleanroom' && sv.modloaderVersion !== data.settings.modloaderVersion && usesCleanMix(sv.modloaderVersion || null)}
					<p class="hint warn-text">{CLEANMIX_WARNING}</p>
				{/if}
				{#if data.running}<p class="faint small">Stop the server to change the loader version.</p>{/if}
				<SnapshotChoice prompt={data.snapshotPrompt} idPrefix="loader" />
				<JavaPrompt {form} action="loaderVersion" />
			</form>
		</SettingsSection>
		{#if !data.pack}{@render updateChecks()}{/if}
	{/if}

	{#snippet updateChecks()}
		{@const found = data.updates.found}
		{#if data.updates.kind}
		<SettingsSection tab="general" id="updates" title="Update checks" editable={may('software')} dirty={dirtyIds.has('updates')}>
			{#snippet description()}
				Looks for a newer {data.updates.kind === 'pack' ? 'pack version' : `${data.instance.modloaderLabel} build`} now and then
				and shows it on the overview, with a button to review and install it. Nothing is installed on its own.
			{/snippet}
			<form method="POST" action="?/updates" class="rows" bind:this={forms.updates} onsubmit={onSectionSubmit}>
				<UpdateCheckFields bind:values={sv} loader={data.updates.kind === 'loader' ? data.settings.modloader : null} mods={data.updates.kind === 'loader'}>
					{#snippet channelHint()}
						{#if data.settings.modloader === 'cleanroom' && !data.pack}
							<p class="hint">Cleanroom calls every build alpha; it is offered builds of its own line (0.5.x stays on 0.5.x).</p>
						{/if}
					{/snippet}
				</UpdateCheckFields>
			</form>
			<div class="inline-row update-status">
				<p class="faint small">
					{#if !data.updates.checkedAt}
						Not checked yet.
					{:else}
						Last checked {formatDateTime(data.updates.checkedAt)}:
						{#if !found}nothing newer.
						{:else if found.skipped}<strong>{found.label}</strong> is out, skipped.
						{:else}{@const note = channelNote(found.channel, found.kind === 'loader' ? data.settings.modloader : null)}<strong>{found.label}</strong>{note ? ` (${note})` : ''} is available.{/if}
					{/if}
				</p>
				<form method="POST" action="?/checkUpdates" use:enhance>
					<button class="button-quiet" type="submit">Check now</button>
				</form>
				{#if found?.skipped}
					<form method="POST" action="?/unskipUpdate" use:enhance>
						<button class="button-quiet" type="submit">Show it again</button>
					</form>
				{/if}
			</div>
		</SettingsSection>
		{/if}
	{/snippet}

	{#if data.cleanroom}
		<CleanroomSection
			cleanroom={data.cleanroom}
			report={data.cleanroomReport}
			javaMajors={data.javaRuntimes.map((j) => j.majorVersion)}
			snapshotPrompt={data.snapshotPrompt}
			{form}
			editable={may('software')}
		/>
	{/if}

	<CopyDeleteSection
		name={data.instance.name}
		busy={data.instance.status === 'provisioning'}
		running={data.running}
		{mayCopy}
		mayDelete={may('delete')}
		mayGrant={data.mayGrant}
	/>

	<!-- =========================================================== Gameplay -->

	<SettingsSection tab="gameplay" title="Rules" editable={may('settings.edit')} dirty={dirtyIds.has('rules')}>
		{@render propertyForm('rules')}
	</SettingsSection>

	<SettingsSection
		tab="gameplay"
		title="World"
		editable={may('settings.edit')}
		description="Seed and type only apply when a world is first generated."
		dirty={dirtyIds.has('world')}
	>
		{@render propertyForm('world')}
	</SettingsSection>

	<!-- ============================================================ Players -->

	<SettingsSection tab="players" title="Joining" editable={may('settings.edit')} dirty={dirtyIds.has('joining')}>
		{#snippet description()}
			Whitelist, operators and bans are managed on the <a href="/instances/{encodeURIComponent(data.instance.id)}/players"
				>Players</a
			> tab.
		{/snippet}
		{@render propertyForm('joining')}
	</SettingsSection>

	<SettingsSection tab="players" title="Permissions" editable={may('settings.edit')} dirty={dirtyIds.has('permissions')}>
		{@render propertyForm('permissions')}
	</SettingsSection>

	<!-- ============================================================ Network -->

	<SettingsSection tab="network" title="Connection" editable={may('settings.edit')} dirty={dirtyIds.has('port') || dirtyIds.has('connection')}>
		<form method="POST" action="?/network" class="rows" bind:this={forms.port} onsubmit={onSectionSubmit}>
			<div class="field">
				<label for="serverPort">Game port <span class="tag warn">restart</span></label>
				<input id="serverPort" name="serverPort" type="number" min="1" max="65535" bind:value={sv.serverPort} />
				<PortCheck instanceId={data.instance.id} field="game" value={sv.serverPort} current={data.settings.serverPort} name="moveGame" />
				<p class="hint">Written to server.properties too.</p>
			</div>
		</form>
		{@render propertyForm('connection')}
	</SettingsSection>

	<SettingsSection tab="network" title="RCON" editable={may('settings.edit')} description="MineShell sends console commands over RCON. Do not expose its port." dirty={dirtyIds.has('rcon')}>
		<form method="POST" action="?/network" class="rows" bind:this={forms.rcon} onsubmit={onSectionSubmit}>
			<div class="field">
				<label for="rconPort">RCON port <span class="tag warn">restart</span></label>
				<input id="rconPort" name="rconPort" type="number" min="1" max="65535" bind:value={sv.rconPort} />
				<PortCheck instanceId={data.instance.id} field="rcon" value={sv.rconPort} current={data.settings.rconPort} name="moveRcon" />
			</div>
			<div class="field">
				<span class="label">RCON password</span>
				<div class="control secret-row">
					<code class="secret">{rconShown ?? '••••••••••••'}</code>
					{#if may('admin') || may('files')}
						<button class="button-quiet" type="button" onclick={toggleRcon}>{rconShown !== null ? 'Hide' : 'Show'}</button>
					{/if}
				</div>
				<p class="hint">Generated when the server was created and stored encrypted.</p>
			</div>
			<div class="check field">
				<input id="rotateRcon" name="rotateRcon" type="checkbox" bind:checked={rotateRcon} />
				<label for="rotateRcon">Generate a new password on save</label>
			</div>
		</form>
	</SettingsSection>

	{#if data.voice}
		<SettingsSection
			tab="network"
			title="Voice chat"
			editable={may('settings.edit')}
			description="Simple Voice Chat talks to players' clients on a UDP port of its own, not through the game port."
			dirty={dirtyIds.has('voice')}
		>
			<form method="POST" action="?/voiceChat" class="rows" bind:this={forms.voice} onsubmit={onSectionSubmit}>
				<div class="field">
					<label for="voicePort">Voice chat port (UDP) <span class="tag warn">restart</span></label>
					<input id="voicePort" name="voicePort" type="number" min="1" max="65535" bind:value={sv.voicePort} />
					<p class="hint">
						Each server on this machine needs its own; MineShell checks it before a start and gives new and copied servers
						a free one. Players reach it like the game port: allow it through the firewall
						(<code class="mono">sudo ufw allow {sv.voicePort}/udp</code>) and forward it as UDP for players from outside.
						{#if data.voice.host}Clients are sent to <code class="mono">{data.voice.host}</code> (voice_host).{/if}
					</p>
				</div>
			</form>
		</SettingsSection>
	{/if}

	<PlayitSection
		instanceId={data.instance.id}
		playit={data.playit}
		voice={data.voice}
		serverPort={data.settings.serverPort}
		editable={may('admin')}
	/>

	<!-- ======================================================== Performance -->

	<SettingsSection tab="performance" title="Distances" editable={may('settings.edit')} description="The biggest lever on CPU and memory use." dirty={dirtyIds.has('distances')}>
		{@render propertyForm('distances')}
	</SettingsSection>

	<SettingsSection tab="performance" title="Ticking and disk" editable={may('settings.edit')} dirty={dirtyIds.has('ticking')}>
		{@render propertyForm('ticking')}
	</SettingsSection>

	<SettingsSection tab="performance" title="Resource limits" editable={may('settings.edit')} dirty={dirtyIds.has('limits')}>
		{#snippet description()}
			Caps systemd puts on the server process, applied at once, also to a running server. The kernel kills the server
			past the memory limit (crash restarts then apply), so leave Java room above its {formatGb(limitHeapMb)} heap. The CPU limit
			slows it down instead; this machine has {data.cpuCores} cores.
		{/snippet}
		<form method="POST" action="?/limits" class="rows" bind:this={forms.limits} onsubmit={onSectionSubmit}>
			<div class="field">
				<span class="label" id="limitMemoryLabel">Memory limit</span>
				<div class="control limit-control">
					<SegmentedChoice
						options={LIMIT_MODES}
						name="limitMemoryMode"
						labelledby="limitMemoryLabel"
						bind:value={
							() => (sv.limitMemoryMb === '' ? 'none' : 'limit'),
							(mode) => (sv.limitMemoryMb = mode === 'none' ? '' : wholeGbAbove(suggestedMemoryLimitMb(limitHeapMb)))
						}
					/>
					{#if sv.limitMemoryMb === ''}
						<input type="hidden" name="limitMemoryMb" value="" />
					{:else}
						<MemoryInput
							id="limitMemoryMb"
							name="limitMemoryMb"
							label="Memory limit"
							minMb={minMemoryLimitMb(limitHeapMb)}
							machineMb={data.machineMemoryMb}
							maxGb={Math.ceil(data.machineMemoryMb / 1024)}
							bind:value={() => Number(sv.limitMemoryMb), (mb) => (sv.limitMemoryMb = mb ?? '')}
						/>
					{/if}
				</div>
				<p class="hint">
					At least {formatGb(minMemoryLimitMb(limitHeapMb))}; around {formatGb(suggestedMemoryLimitMb(limitHeapMb))} leaves room for
					a busy pack. The server is killed past it.
					{#if limitHeapMb !== (s.memoryMaxMb ?? 0)}The running server started with a {formatGb(limitHeapMb)} heap; the
						{formatGb(s.memoryMaxMb ?? 0)} one applies after a restart.{/if}
				</p>
			</div>
			<div class="field">
				<span class="label" id="limitCpuLabel">CPU limit</span>
				<div class="control limit-control">
					<SegmentedChoice
						options={LIMIT_MODES}
						name="limitCpuMode"
						labelledby="limitCpuLabel"
						bind:value={
							() => (sv.limitCpuPercent === '' ? 'none' : 'limit'),
							(mode) => (sv.limitCpuPercent = mode === 'none' ? '' : Math.max(1, Math.floor(data.cpuCores / 2)) * 100)
						}
					/>
					{#if sv.limitCpuPercent === ''}
						<input type="hidden" name="limitCpuPercent" value="" />
					{:else}
						<CpuInput
							id="limitCpuPercent"
							name="limitCpuPercent"
							label="CPU limit"
							cores={data.cpuCores}
							bind:value={() => Number(sv.limitCpuPercent), (pct) => (sv.limitCpuPercent = pct ?? '')}
						/>
					{/if}
				</div>
				<p class="hint">Past it the server is slowed down, not stopped.</p>
			</div>
		</form>
	</SettingsSection>

	<!-- ====================================================== Java & memory -->

	<!-- Memory has an action of its own; its fields sit between the launch form's sections and join it by id. -->
	<form method="POST" action="?/memory" id="memory-form" bind:this={forms.memory} onsubmit={onSectionSubmit}></form>
	<form method="POST" action="?/launch" bind:this={forms.launch} onsubmit={onSectionSubmit}>
		<SettingsSection tab="java" title="Runtime" editable={may('software')} dirty={dirtyIds.has('launch')}>
			{#snippet description()}
				{data.instance.modloaderLabel} on Minecraft {s.minecraftVersion} expects Java {data.requiredJava}. MineShell picks a
				match unless you pin one.
			{/snippet}
			{#snippet aside()}
				<button class="button-quiet" type="submit" formaction="?/rescanJava">Rescan for Java</button>
			{/snippet}
			{#if data.javaResolution.warning}
				<div class="notice warning"><p>{data.javaResolution.warning}</p></div>
			{/if}
			<div class="rows">
				<div class="field">
					<label for="javaPath">Java runtime <span class="tag warn">restart</span></label>
					<select id="javaPath" name="javaPath" bind:value={sv.javaPath}>
						<option value="">
							Match automatically (currently {data.autoJava.path ?? 'nothing installed'}{data.autoJava.origin === 'default'
								? ', the default set in MineShell settings'
								: ''})
						</option>
						{#each data.javaRuntimes as java (java.path)}
							<option value={java.path}>Java {java.majorVersion} - {java.path}</option>
						{/each}
					</select>
				</div>
				<div class="field">
					<label for="javaPathManual">Or a path by hand</label>
					<input
						id="javaPathManual"
						name="javaPathManual"
						class="mono"
						placeholder="/usr/lib/jvm/java-21-openjdk/bin/java"
						bind:value={sv.javaPathManual}
					/>
					<p class="hint">Not listed? The full path to a <code>java</code> binary here is used as-is.</p>
				</div>
			</div>
		</SettingsSection>

		<SettingsSection tab="java" title="Memory" editable={may('settings.edit')} dirty={dirtyIds.has('memory')}>
			<div class="rows">
				<div class="field">
					<label for="memoryMaxMb">Maximum memory <span class="tag warn">restart</span></label>
					<MemoryInput id="memoryMaxMb" name="memoryMaxMb" form="memory-form" label="Maximum memory" machineMb={data.machineMemoryMb} bind:value={sv.memoryMaxMb} />
					{#if data.runningMemoryMaxMb !== null && data.runningMemoryMaxMb !== s.memoryMaxMb}
						<p class="hint">The server is running with {data.runningMemoryMaxMb} MB until it restarts.</p>
					{/if}
				</div>
				<div class="field">
					<label for="memoryMinMb">Starting memory <span class="tag warn">restart</span></label>
					<MemoryInput id="memoryMinMb" name="memoryMinMb" form="memory-form" label="Starting memory" minMb={256} machineMb={data.machineMemoryMb} bind:value={sv.memoryMinMb} />
				</div>
			</div>
			{#await data.memoryAdvice then advice}
				{#if advice}
					<div class="memory-advice">
						<MemoryAdvice
							{advice}
							all
							onUse={(mb) => {
								sv.memoryMaxMb = mb;
								if ((sv.memoryMinMb ?? 0) > mb) sv.memoryMinMb = mb;
							}}
						/>
					</div>
				{/if}
			{/await}
		</SettingsSection>

		<SettingsSection tab="java" title="JVM flags" editable={may('software')} dirty={dirtyIds.has('launch')}>
			<div class="rows">
				<div class="field">
					<label for="applyPreset">Flag preset</label>
					<select id="applyPreset" name="applyPreset" bind:value={presetToApply}>
						<option value="">Keep the current flags</option>
						{#each data.jvmPresets as preset (preset.id)}
							<option value={preset.id} disabled={!preset.runs}
								>{preset.name}{preset.builtIn ? '' : ' (saved)'}{preset.runs ? '' : ` - not on Java ${data.javaResolution.majorVersion}`}</option
							>
						{/each}
					</select>
					{#if presetToApply}
						{@const chosen = data.jvmPresets.find((p) => p.id === presetToApply)}
						{#if chosen}
							<p class="hint">{chosen.description} Saving replaces the arguments below; memory flags come from Memory either way.</p>
						{/if}
					{:else}
						<p class="hint">
							{#if currentPreset}The current flags are the {currentPreset.name} preset.{:else}The current flags match no preset.{/if}
						</p>
					{/if}
				</div>
				{#if presetToApply}
					{@const chosen = data.jvmPresets.find((p) => p.id === presetToApply)}
					{#if chosen}<pre class="preset-preview mono">{chosen.flags || '(memory settings only)'}</pre>{/if}
				{/if}
				<div class="field wide">
					<label for="jvmArgs">JVM arguments <span class="tag warn">restart</span></label>
					<textarea id="jvmArgs" name="jvmArgs" rows="3" class="mono" spellcheck="false" disabled={Boolean(presetToApply)} bind:value={sv.jvmArgs}
					></textarea>
					<p class="hint">
						<code>-Xms</code> and <code>-Xmx</code> are rewritten from Memory, so you do not have to keep them in sync.
					</p>
				</div>
				<div class="field wide">
					<label for="launchArgs">Launch arguments <span class="tag warn">restart</span></label>
					<input id="launchArgs" name="launchArgs" class="mono" bind:value={sv.launchArgs} />
					<p class="hint">
						After the JVM options, written to the unit environment as <code>MS_LAUNCH_ARGS</code>. Modern Forge and NeoForge
						use an <code>@argfile</code> here instead of a jar. Only change this if a loader install produced the wrong result.
					</p>
				</div>
			</div>
		</SettingsSection>
	</form>

	{#if data.access.globalAdmin}<PresetsSection jvmArgs={sv.jvmArgs} />{/if}

	<!-- ========================================================= Automation -->

	<SettingsSection tab="automation" title="Restarts" editable={may('settings.edit')} dirty={dirtyIds.has('restarts')}>
		<form method="POST" action="?/restarts" class="rows" bind:this={forms.restarts} onsubmit={onSectionSubmit}>
			<RestartFields bind:values={sv} bootNote={data.bootNote} />
		</form>
	</SettingsSection>

	{#if may('console.read') || may('console.command')}
		<CommandsSection commands={data.scheduledCommands} editable={may('console.command')} />
	{/if}

	<NotificationsSection notifications={data.notifications} editable={may('admin')} />

	<!-- ========================================================== Snapshots -->

	<SettingsSection
		tab="snapshots"
		title="Scheduled snapshots"
		editable={may('backups.create')}
		description="A copy of the world on a schedule, kept by the settings below like every other snapshot."
		dirty={dirtyIds.has('snapshotSchedule')}
	>
		<form method="POST" action="?/snapshotSchedule" class="rows" bind:this={forms.snapshotSchedule} onsubmit={onSectionSubmit}>
			<div class="field">
				<label for="snapshotEvery">Take one</label>
				<select id="snapshotEvery" name="snapshotEvery" bind:value={sv.snapshotEvery}>
					<option value="off">Never</option>
					<option value="daily">At a fixed time each day</option>
					<option value="interval">Every few hours</option>
				</select>
				{#if sv.snapshotEvery !== 'off' && data.snapshotNextAt && !dirtyIds.has('snapshotSchedule')}
					<p class="hint">Next: {formatDateTime(data.snapshotNextAt)}.</p>
				{/if}
			</div>
			{#if sv.snapshotEvery === 'daily'}
				<div class="field">
					<label for="snapshotDailyTime">At</label>
					<input id="snapshotDailyTime" name="snapshotDailyTime" type="time" bind:value={sv.snapshotDailyTime} />
				</div>
			{:else}
				<input type="hidden" name="snapshotDailyTime" value={sv.snapshotDailyTime} />
			{/if}
			{#if sv.snapshotEvery === 'interval'}
				<div class="field">
					<label for="snapshotIntervalHours">How often</label>
					<PresetSelect id="snapshotIntervalHours" name="snapshotIntervalHours" choices={EVERY_HOURS} other={unevenHours} bind:value={sv.snapshotIntervalHours} />
					<p class="hint">On the clock: every hour at :00; every 6 hours at 0:00, 6:00, 12:00 and 18:00.</p>
				</div>
			{:else}
				<input type="hidden" name="snapshotIntervalHours" value={sv.snapshotIntervalHours} />
			{/if}
			{#if sv.snapshotEvery !== 'off'}
				<div class="field">
					<label for="snapshotWhileRunning">When the server is running</label>
					<select id="snapshotWhileRunning" name="snapshotWhileRunning" bind:value={sv.snapshotWhileRunning}>
						<option value="live">Copy it while it runs</option>
						<option value="stop">Stop it, copy, start it again</option>
					</select>
					<p class="hint">
						{#if sv.snapshotWhileRunning === 'live'}
							Saving is paused for the copy (save-off, save-all), then turned back on; players keep playing. A mod that
							writes its own files outside the world's saves can still be caught mid-write.
						{:else}
							Players are warned first, like a scheduled restart. It starts again as soon as the copy is done, also if the
							copy failed. A stopped server is copied as it is either way.
						{/if}
					</p>
				</div>
				{#if sv.snapshotWhileRunning === 'stop'}
					<div class="field">
						<span class="label" id="snapshotWarnMinutes-label">Warn players ahead</span>
						<div class="control">
							<WarnChoice name="snapshotWarnMinutes" labelledby="snapshotWarnMinutes-label" bind:value={sv.snapshotWarnMinutes} />
						</div>
					</div>
				{:else}
					<input type="hidden" name="snapshotWarnMinutes" value={sv.snapshotWarnMinutes} />
				{/if}
				<div class="check field">
					<input id="snapshotSkipIdle" name="snapshotSkipIdle" type="checkbox" class="switch" role="switch" bind:checked={sv.snapshotSkipIdle} />
					<label for="snapshotSkipIdle">Skip when nobody was online since the last snapshot</label>
				</div>
				<div class="field">
					<p class="hint">
						Saves space: an empty server's world rarely changes. But chunk loaders keep farms and machines running
						with nobody on, and those changes then wait for the next snapshot someone played before.
					</p>
				</div>
			{:else}
				<input type="hidden" name="snapshotWhileRunning" value={sv.snapshotWhileRunning} />
				<input type="hidden" name="snapshotWarnMinutes" value={sv.snapshotWarnMinutes} />
				{#if sv.snapshotSkipIdle}<input type="hidden" name="snapshotSkipIdle" value="on" />{/if}
			{/if}
		</form>
	</SettingsSection>

	<SettingsSection tab="snapshots" title="World snapshots" editable={may('backups.delete')} dirty={dirtyIds.has('snapshots')}>
		{#snippet description()}
			How many to keep for this server. A blank field follows the <a href="/settings">MineShell settings</a>, shown greyed.
			Now: {data.snapshotSettings.usage.full} full, {data.snapshotSettings.usage.partial} partial,
			{data.snapshotSettings.usage.pinned} pinned, {formatBytes(data.snapshotSettings.usage.bytes)} in all.
		{/snippet}
		{#snippet aside()}
			<button class="button-quiet" type="submit" form="snapshot-form" name="useGlobal" value="on">Use the global settings</button>
		{/snippet}
		<form id="snapshot-form" method="POST" action="?/snapshotPolicy" class="rows" bind:this={forms.snapshots} onsubmit={onSectionSubmit}>
			<SnapshotPolicyFields bind:values={snapshotValues} placeholders={data.snapshotSettings.global} idPrefix="server-snap" />
		</form>
	</SettingsSection>

	<SettingsSection tab="snapshots" title="Backup copies" editable={may('backups.delete')} dirty={dirtyIds.has('backups')}>
		{#snippet description()}
			Copies of this server's snapshots in a backup folder, apart from its disk, made right after each snapshot.
			{#if data.backups.last && sv.backupDestination}
				<span class={data.backups.last.ok ? '' : 'backup-failed'}>
					Last {data.backups.last.ok ? 'copy' : 'try'}, {formatDateTime(data.backups.last.at)}: {data.backups.last.message}
				</span>
			{/if}
		{/snippet}
		<form method="POST" action="?/backups" class="rows" bind:this={forms.backups} onsubmit={onSectionSubmit}>
			<div class="field">
				<label for="backupDestination">Copy to</label>
				<select id="backupDestination" name="backupDestination" bind:value={sv.backupDestination}>
					<option value="">Nowhere</option>
					{#each data.backups.destinations as folder (folder.id)}
						<option value={folder.id}>{folder.name} ({folder.path})</option>
					{/each}
				</select>
				{#if !data.backups.destinations.length}
					<p class="hint">No backup folders yet: the owner adds them in <a href="/settings?tab=snapshots">MineShell settings</a>.</p>
				{/if}
			</div>
			{#if sv.backupDestination}
				<div class="field">
					<label for="backupCopy">Which snapshots</label>
					<select id="backupCopy" name="backupCopy" bind:value={sv.backupCopy}>
						{#each BACKUP_COPY_CHOICES as choice (choice.value)}
							<option value={choice.value}>{choice.label}</option>
						{/each}
					</select>
					<p class="hint">Partial ones (one dimension, before a reset or prune) stay here only.</p>
				</div>
				<div class="field">
					<label for="backupKeep">Copies kept there</label>
					<input id="backupKeep" name="backupKeep" type="number" min="1" max="1000" bind:value={sv.backupKeep} />
					<p class="hint">The newest ones there; the settings above are for the ones here. Pinned snapshots are kept there too, not counted.</p>
				</div>
			{:else}
				<input type="hidden" name="backupCopy" value={sv.backupCopy} />
				<input type="hidden" name="backupKeep" value={sv.backupKeep} />
			{/if}
		</form>
	</SettingsSection>

	<!-- =========================================================== Advanced -->

	<SettingsSection tab="advanced" title="Console" editable={may('settings.edit')} dirty={dirtyIds.has('console')}>
		<form method="POST" action="?/console" class="rows" bind:this={forms.console} onsubmit={onSectionSubmit}>
			<ConsoleFields bind:values={sv} />
		</form>
	</SettingsSection>

	<SettingsSection
		tab="advanced"
		title="Other keys"
		editable={may('settings.edit')}
		description="Keys MineShell has no control for, usually added by a mod or the pack. Kept exactly as written."
		dirty={dirtyIds.has('more')}
	>
		<form method="POST" action="?/properties" class="rows" bind:this={forms.more} onsubmit={onSectionSubmit}>
			{#each unplaced as field (field.key)}
				<div class="field">
					{#if field.type === 'boolean'}
						<PropertyInput {field} bind:checked={fieldChecks[field.key]} />
					{:else}
						<PropertyInput {field} bind:value={fieldValues[field.key]} />
					{/if}
				</div>
			{/each}
			{#each data.properties.extras as extra (extra.key)}
				<div class="field">
					<label for={`extra-${extra.key}`} class="mono">{extra.key}</label>
					<input id={`extra-${extra.key}`} name={`extra:${extra.key}`} type="text" class="mono" bind:value={fieldValues[`extra:${extra.key}`]} />
				</div>
			{:else}
				{#if !unplaced.length}<p class="faint small">None: every key in server.properties has a control above.</p>{/if}
			{/each}
		</form>
	</SettingsSection>

	<SettingsSection tab="advanced" title="Raw file" editable={may('settings.edit')} description="Edit server.properties directly. Saved as-is; comments and ordering are not kept.">
		<form method="POST" action="?/propertiesRaw" use:enhance={keepValues} class="block raw">
			<textarea name="raw" rows="16" spellcheck="false" class="mono" bind:value={rawValue}></textarea>
			<div class="button-row">
				<button type="submit" disabled={rawValue === data.properties.raw}>Save file</button>
				<span class="faint small">Saved on its own, not with the bar below.</span>
			</div>
		</form>
	</SettingsSection>

	{#if query.trim()}
		<p class="faint small no-match">Sections that do not mention "{query.trim()}" are hidden.</p>
	{/if}
</div>

<div class="savebar" class:dirty={dirty.length > 0}>
	<span class="summary">
		{#if dirty.length}
			<span class="wide">{dirty.length} section{dirty.length === 1 ? '' : 's'} changed across {dirtyTabs.size} tab{dirtyTabs.size === 1 ? '' : 's'}</span>
			<span class="narrow">{dirty.length} change{dirty.length === 1 ? '' : 's'}</span>
			{#if needsRestart}<span class="muted">· needs a restart</span>{/if}
		{:else}
			No unsaved changes
		{/if}
	</span>
	{#if dirty.length}
		<div class="button-row">
			<button type="button" class="button-quiet" onclick={discard} disabled={saving}>Discard</button>
			{#if needsRestart}
				<button type="button" onclick={() => save(false)} disabled={saving}><span class="wide">Save, restart later</span><span class="narrow">Save only</span></button>
				<button type="button" class="button-primary" onclick={() => save(true)} disabled={saving}>
					{saving ? 'Saving' : 'Save and restart'}
				</button>
			{:else}
				<button type="button" class="button-primary" onclick={() => save(false)} disabled={saving}>{saving ? 'Saving' : 'Save'}</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* The backup section's last try, when it failed. */
	.backup-failed {
		color: var(--error);
	}

	.subhead {
		flex-wrap: nowrap;
	}

	/* No limit / Limit above the slider, together in the field's control column. */
	.limit-control {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		width: 100%;
	}

	.subhead .subtabs {
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		overflow-y: hidden;
		overscroll-behavior-x: contain;
	}

	/* Nine tabs and the search share one row at common widths. */
	.subhead .subtabs button {
		padding-inline: 0.6rem;
	}

	/* On a phone the tabs get the whole row and the search goes under them. */
	@media (max-width: 60rem) {
		.subhead {
			flex-wrap: wrap;
		}

		.subhead .subtabs {
			flex-basis: 100%;
		}

		.subhead .search {
			width: 100%;
		}
	}

	.subhead .sep {
		width: 1px;
		height: 18px;
		align-self: center;
		margin: 0 0.35rem;
		background: var(--line-strong);
	}

	.search {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 11.5rem;
		flex: none;
		margin-bottom: 0.4rem;
		background: var(--bg-sunken);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
		padding: 0 0.6rem;
		color: var(--text-faint);
	}

	.search input {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: 0;
		padding: 0.4rem 0;
		font-size: 0.9rem;
		outline: none;
	}

	.settings {
		max-width: 54rem;
		padding-bottom: var(--space-6);
	}

	.running-note {
		margin: var(--space-2) 0 0;
	}

	.secret-row {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}

	.secret {
		padding: 0.3rem 0.6rem;
		min-width: 11rem;
	}

	.embedded :global(.panel) {
		margin-top: 0.9rem;
	}

	.update-status {
		margin-top: var(--space-3);
		align-items: center;
	}

	.update-status p {
		margin: 0;
	}

	.preset-preview {
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-3);
		margin: var(--space-2) 0;
		font-size: 0.75rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.raw textarea {
		line-height: 1.7;
		margin-bottom: var(--space-3);
	}

	textarea:disabled {
		opacity: 0.5;
	}

	.warn-text {
		color: var(--warning);
	}

	.no-match {
		margin-top: var(--space-5);
	}

	/* ---- the save bar, pinned to the bottom of the window */

	.savebar {
		position: sticky;
		bottom: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		margin: 0 -2.5rem calc(var(--space-5) * -1);
		padding: 0.75rem 2.5rem;
		min-height: 4rem;
		border-top: 1px solid var(--line);
		background: var(--bg);
		color: var(--text-faint);
		font-size: 0.92rem;
	}

	.savebar.dirty {
		color: var(--warning);
		background: color-mix(in srgb, var(--warning) 7%, var(--bg));
	}

	.savebar .narrow {
		display: none;
	}

	@media (max-width: 60rem) {
		/* One short line, then the buttons side by side across the width. */
		.savebar {
			flex-wrap: wrap;
			gap: 0.5rem;
			min-height: 0;
			margin: 0 calc(var(--space-4) * -1) calc(var(--space-4) * -1);
			padding: 0.6rem var(--space-4) calc(0.6rem + env(safe-area-inset-bottom));
			font-size: 0.85rem;
		}

		/* Nothing to save: no bar taking room at the bottom of a phone. */
		.savebar:not(.dirty) {
			display: none;
		}

		.savebar .summary {
			width: 100%;
		}

		.savebar .wide {
			display: none;
		}

		.savebar .narrow {
			display: inline;
		}

		.savebar .button-row {
			display: grid;
			grid-auto-flow: column;
			grid-auto-columns: minmax(0, 1fr);
			gap: 0.5rem;
			width: 100%;
		}

		.savebar .button-row button {
			width: 100%;
			margin: 0;
		}
	}
	.memory-advice {
		margin-top: var(--space-3);
	}
</style>
