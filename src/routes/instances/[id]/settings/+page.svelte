<script lang="ts">
	import { deserialize, enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import Flash from '#lib/components/Flash.svelte';
	import CleanroomOption from '#lib/components/CleanroomOption.svelte';
	import PackChangePanel from '#lib/components/PackChangePanel.svelte';
	import SnapshotChoice from '#lib/components/SnapshotChoice.svelte';
	import JavaPrompt from '#lib/components/JavaPrompt.svelte';
	import RestartFields from '#lib/components/RestartFields.svelte';
	import ConsoleFields from '#lib/components/ConsoleFields.svelte';
	import SnapshotPolicyFields from '#lib/components/SnapshotPolicyFields.svelte';
	import PropertyInput from '#lib/components/PropertyInput.svelte';
	import SettingsSection, { provideSettingsView } from '#lib/components/SettingsSection.svelte';
	import { formatBytes } from '#lib/shared/format.js';
	import { CLEANMIX_WARNING, CLEANROOM_GUIDE_URL, usesCleanMix } from '#lib/shared/cleanroom.js';

	let { data, form } = $props();

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
			consoleBacklogLines: d.consoleBacklogLines,
			consoleBufferLines: d.consoleBufferLines,
			limitMemoryMb: (d.limitMemoryMb ?? '') as number | string,
			limitCpuPercent: (d.limitCpuPercent ?? '') as number | string
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
	let showRcon = $state(false);
	let presetToApply = $state('');
	let presetName = $state('');
	let showSavePreset = $state(false);
	let commandMode = $state<'interval' | 'daily'>('interval');
	const formatTime = (at: number) =>
		new Date(at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

	// ---- server.properties, a section at a time

	const PROPERTY_SECTIONS: Record<string, string[]> = {
		motd: ['motd'],
		rules: ['difficulty', 'gamemode', 'force-gamemode', 'hardcore', 'allow-flight', 'spawn-monsters', 'enable-command-block'],
		world: ['level-name', 'level-seed', 'level-type', 'generate-structures', 'allow-nether', 'spawn-protection'],
		joining: ['max-players', 'white-list', 'enforce-whitelist', 'player-idle-timeout'],
		permissions: ['pvp', 'op-permission-level'],
		connection: ['server-ip', 'online-mode', 'enable-query'],
		distances: ['view-distance', 'simulation-distance', 'entity-broadcast-range-percentage'],
		ticking: ['max-tick-time', 'sync-chunk-writes', 'network-compression-threshold']
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
		{ id: 'identity', tab: 'general', label: 'Identity', restart: false, dirty: () => svChanged('name', 'minecraftVersion') },
		{ id: 'motd', tab: 'general', label: 'Server description', restart: true, dirty: () => PROPERTY_SECTIONS.motd.some(changedProperty) },
		{ id: 'rules', tab: 'gameplay', label: 'Rules', restart: true, dirty: () => PROPERTY_SECTIONS.rules.some(changedProperty) },
		{ id: 'world', tab: 'gameplay', label: 'World', restart: true, dirty: () => PROPERTY_SECTIONS.world.some(changedProperty) },
		{ id: 'joining', tab: 'players', label: 'Joining', restart: true, dirty: () => PROPERTY_SECTIONS.joining.some(changedProperty) },
		{ id: 'permissions', tab: 'players', label: 'Permissions', restart: true, dirty: () => PROPERTY_SECTIONS.permissions.some(changedProperty) },
		{ id: 'port', tab: 'network', label: 'Game port', restart: true, dirty: () => svChanged('serverPort') },
		{ id: 'connection', tab: 'network', label: 'Connection', restart: true, dirty: () => PROPERTY_SECTIONS.connection.some(changedProperty) },
		{ id: 'rcon', tab: 'network', label: 'RCON', restart: true, dirty: () => svChanged('rconPort') || rotateRcon },
		{ id: 'distances', tab: 'performance', label: 'Distances', restart: true, dirty: () => PROPERTY_SECTIONS.distances.some(changedProperty) },
		{ id: 'ticking', tab: 'performance', label: 'Ticking and disk', restart: true, dirty: () => PROPERTY_SECTIONS.ticking.some(changedProperty) },
		{ id: 'limits', tab: 'performance', label: 'Resource limits', restart: true, dirty: () => svChanged('limitMemoryMb', 'limitCpuPercent') },
		{
			id: 'runtime',
			tab: 'java',
			label: 'Java and memory',
			restart: true,
			dirty: () => svChanged('javaPath', 'javaPathManual', 'memoryMaxMb', 'memoryMinMb', 'jvmArgs', 'launchArgs') || !!presetToApply
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
					'restartSkipIfPlayers'
				)
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

	async function post(action: string, body: FormData) {
		const res = await fetch(action, {
			method: 'POST',
			body,
			headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
		});
		return deserialize(await res.text());
	}

	const resultMessage = (result: Awaited<ReturnType<typeof post>>, fallback: string) =>
		result.type === 'success' || result.type === 'failure'
			? String((result.data as { message?: string } | undefined)?.message ?? fallback)
			: result.type === 'error'
				? (result.error?.message ?? fallback)
				: fallback;

	async function save(restartAfter: boolean) {
		if (saving || !dirty.length) return;
		saving = true;
		message = null;
		const list = [...dirty];
		let done = 0;
		try {
			for (const section of list) {
				const formEl = forms[section.id];
				if (!formEl) continue;
				const result = await post(formEl.action, new FormData(formEl));
				if (result.type === 'failure' || result.type === 'error') {
					message = { ok: false, message: `${section.label}: ${resultMessage(result, 'Not saved.')}` };
					tab = section.tab;
					query = '';
					return;
				}
				if (section.id === 'rcon') rotateRcon = false;
				if (section.id === 'runtime') presetToApply = '';
				done++;
			}
			if (restartAfter) {
				const body = new FormData();
				body.set('verb', 'restart');
				const result = await post(`/instances/${encodeURIComponent(data.instance.id)}?/power`, body);
				message =
					result.type === 'success'
						? { ok: true, message: `Saved ${done} section${done === 1 ? '' : 's'}. Restarting the server.` }
						: { ok: false, message: `Saved, but the restart failed: ${resultMessage(result, 'no answer')}` };
			} else {
				message = {
					ok: true,
					message: needsRestart ? 'Saved. Restart the server for the changes marked restart to apply.' : 'Saved.'
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
			const result = await post(action, new FormData(formEl, submitter));
			message = { ok: result.type === 'success', message: resultMessage(result, 'Done.') };
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

	// ---- server icon: scaled to the 64x64 PNG Minecraft wants, here in the browser
	const iconUrl = $derived(`/api/instances/${encodeURIComponent(data.instance.id)}/icon`);
	// svelte-ignore state_referenced_locally
	let hasIcon = $state(data.hasIcon);
	let iconVersion = $state(0);
	let iconError = $state('');

	/** Centre-crop to a square and scale to 64x64, as a PNG. */
	async function toIcon(file: File): Promise<Blob> {
		const image = await createImageBitmap(file);
		const side = Math.min(image.width, image.height);
		const canvas = document.createElement('canvas');
		canvas.width = 64;
		canvas.height = 64;
		const ctx = canvas.getContext('2d')!;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 64, 64);
		return new Promise((resolve, reject) =>
			canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not convert the image.'))), 'image/png')
		);
	}

	async function pickIcon(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		iconError = '';
		try {
			const res = await fetch(iconUrl, { method: 'PUT', body: await toIcon(file) });
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Upload failed.');
			hasIcon = true;
			iconVersion++;
		} catch (err) {
			iconError = err instanceof Error ? err.message : 'Upload failed.';
		}
	}

	async function removeIcon() {
		iconError = '';
		const res = await fetch(iconUrl, { method: 'DELETE' });
		if (res.ok) hasIcon = false;
		else iconError = 'Could not remove the icon.';
	}

	// ---- copy and delete
	let showClone = $state(false);
	let showDelete = $state(false);
	let confirmName = $state('');
</script>

{#snippet propertyRows(section: string)}
	{#each fieldsOf(section) as field (field.key)}
		<div class="field" class:changed={changedProperty(field.key)}>
			{#if field.type === 'boolean'}
				<PropertyInput {field} bind:checked={fieldChecks[field.key]} />
			{:else}
				<PropertyInput {field} bind:value={fieldValues[field.key]} />
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

	<SettingsSection tab="general" title="Identity" dirty={dirtyIds.has('identity') || dirtyIds.has('motd')}>
		{#snippet description()}
			The folder and systemd unit (<code class="mono">{data.instance.id}</code>) are fixed at creation, so renaming only changes
			the label.
		{/snippet}
		<form method="POST" action="?/general" class="rows" bind:this={forms.identity} onsubmit={onSectionSubmit}>
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
				{/if}
				<p class="hint">
					Records what is installed, to choose Java and filter mod searches. Changing it does not reinstall anything.
					{#if !data.minecraftVersions.length}Mojang's version list was unreachable, so this is a plain field.{/if}
				</p>
			</div>
		</form>
		{@render propertyForm('motd')}
	</SettingsSection>

	<SettingsSection tab="general" title="Server icon" description="Shown next to the server in players' server lists.">
		<div class="block icon-block">
			{#if hasIcon}
				<img src="{iconUrl}?v={iconVersion}" alt="Server icon" width="64" height="64" />
			{:else}
				<div class="icon-placeholder" aria-hidden="true">?</div>
			{/if}
			<p class="muted small grow">
				Any image works. It is cropped to a square and scaled to the 64×64 PNG Minecraft needs. Takes effect on the next
				start.
			</p>
			<div class="button-row">
				<label class="button">
					{hasIcon ? 'Replace' : 'Choose an image'}
					<input type="file" accept="image/*" class="visually-hidden" onchange={pickIcon} />
				</label>
				{#if hasIcon}<button class="button-quiet" type="button" onclick={removeIcon}>Remove</button>{/if}
			</div>
		</div>
		{#if iconError}<p class="hint warn-text">{iconError}</p>{/if}
	</SettingsSection>

	{#if data.pack}
		<SettingsSection tab="general" title="Modpack" description="Change the pack version; the world and your own mods stay.">
			<div class="embedded">
				<PackChangePanel instanceId={data.instance.id} pack={data.pack} running={data.running} snapshotPrompt={data.snapshotPrompt} {form} />
			</div>
		</SettingsSection>
	{/if}

	{#if data.settings.modloader !== 'vanilla'}
		<SettingsSection tab="general" title="{data.instance.modloaderLabel} version">
			{#snippet description()}
				Installed: <strong>{data.settings.modloaderVersion ?? 'not recorded'}</strong>. Reinstalls the loader in place; the
				world, configs and mods are left alone, and the current install is put back if the new one fails.
			{/snippet}
			<form method="POST" action="?/loaderVersion" use:enhance={keepValues} class="block">
				<div class="inline-row">
					{#if data.loaderVersions.length}
						<select id="modloaderVersion" name="modloaderVersion" bind:value={sv.modloaderVersion} aria-label="Version to install">
							{#if sv.modloaderVersion && !data.loaderVersions.includes(sv.modloaderVersion)}
								<option value={sv.modloaderVersion}>{sv.modloaderVersion} (installed)</option>
							{/if}
							{#each data.loaderVersions.slice(0, 60) as version (version)}
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
	{/if}

	{#if data.cleanroom}
		{@const cr = data.cleanroom}
		<SettingsSection tab="general" title="Cleanroom">
			{#snippet description()}
				{#if cr.onCleanroom}
					This server runs Cleanroom, a Forge 1.12.2 fork for modern Java.
					{#if cr.backupCreatedAt}
						The Forge install it replaced was kept on {new Date(cr.backupCreatedAt).toLocaleDateString()} and can be restored.
					{/if}
				{:else}
					Cleanroom is a Forge 1.12.2 fork for modern Java that loads the same mods, usually faster. Migrating moves the Forge
					files into <code>.mineshell/forge-backup</code>, so you can switch back here.
				{/if}
			{/snippet}
			<div class="block">
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
					<p class="faint small">Stop the server to {cr.onCleanroom ? 'change' : 'migrate'} it.</p>
				{/if}

				{#if cr.onCleanroom}
					<div class="button-row">
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
								<SnapshotChoice prompt={data.snapshotPrompt} idPrefix="revert" />
								<button type="submit" disabled={cr.running}>Revert to Forge</button>
							</form>
						{/if}
					</div>
				{:else}
					<form method="POST" action="?/migrateCleanroom" use:enhance>
						<CleanroomOption javaMajors={data.javaRuntimes.map((j) => j.majorVersion)} toggle={false} idPrefix="migrate-cleanroom" />
						<SnapshotChoice prompt={data.snapshotPrompt} idPrefix="migrate" />
						<JavaPrompt {form} action="migrateCleanroom" />
						<button class="button-primary" type="submit" disabled={cr.running}>Migrate to Cleanroom</button>
					</form>
				{/if}
			</div>
		</SettingsSection>
	{/if}

	<SettingsSection tab="general" title="Copy or delete">
		<div class="danger-box">
			<div class="danger-row">
				<div>
					<div class="strong">Copy this server</div>
					<div class="muted small">
						Same files, mods and settings on its own ports, to try a pack update or a migration on first. Snapshots are
						not copied.
					</div>
				</div>
				{#if !showClone}<button type="button" onclick={() => (showClone = true)}>Copy server</button>{/if}
			</div>
			{#if showClone}
				<form method="POST" action="?/clone" use:enhance class="danger-form">
					<div class="field">
						<label for="clone-name">Name of the copy</label>
						<input id="clone-name" name="name" value="{data.instance.name} (copy)" maxlength="80" required />
					</div>
					{#if data.instance.status === 'provisioning' || data.running}
						<p class="hint">Stop the server to copy it; a running server's world is still being written.</p>
					{/if}
					<div class="button-row">
						<button class="button-primary" type="submit" disabled={data.running || data.instance.status === 'provisioning'}>
							Copy
						</button>
						<button class="button-quiet" type="button" onclick={() => (showClone = false)}>Cancel</button>
					</div>
				</form>
			{/if}
			<div class="danger-row bad">
				<div>
					<div class="strong">Delete this server</div>
					<div class="muted small">Stops it, removes its systemd unit and optionally every file, the world included.</div>
				</div>
				{#if !showDelete}
					<button class="button-danger" type="button" onclick={() => (showDelete = true)}>Delete server</button>
				{/if}
			</div>
			{#if showDelete}
				<form method="POST" action="?/delete" use:enhance class="danger-form bad">
					<div class="field">
						<label for="confirm">
							Type <strong>DELETE</strong> to confirm you want to remove <strong>{data.instance.name}</strong>
						</label>
						<input id="confirm" name="confirm" bind:value={confirmName} autocomplete="off" placeholder="DELETE" />
					</div>
					<div class="check field">
						<input id="deleteFiles" name="deleteFiles" type="checkbox" />
						<label for="deleteFiles">Also delete every file, including the world. This cannot be undone.</label>
					</div>
					<div class="button-row">
						<button class="button-danger" type="submit" disabled={confirmName.trim().toUpperCase() !== 'DELETE'}>
							Delete permanently
						</button>
						<button class="button-quiet" type="button" onclick={() => (showDelete = false)}>Cancel</button>
					</div>
				</form>
			{/if}
		</div>
	</SettingsSection>

	<!-- =========================================================== Gameplay -->

	<SettingsSection tab="gameplay" title="Rules" dirty={dirtyIds.has('rules')}>
		{@render propertyForm('rules')}
	</SettingsSection>

	<SettingsSection
		tab="gameplay"
		title="World"
		description="Seed and type only apply when a world is first generated."
		dirty={dirtyIds.has('world')}
	>
		{@render propertyForm('world')}
	</SettingsSection>

	<!-- ============================================================ Players -->

	<SettingsSection tab="players" title="Joining" dirty={dirtyIds.has('joining')}>
		{#snippet description()}
			Whitelist, operators and bans are managed on the <a href="/instances/{encodeURIComponent(data.instance.id)}/players"
				>Players</a
			> tab.
		{/snippet}
		{@render propertyForm('joining')}
	</SettingsSection>

	<SettingsSection tab="players" title="Permissions" dirty={dirtyIds.has('permissions')}>
		{@render propertyForm('permissions')}
	</SettingsSection>

	<!-- ============================================================ Network -->

	<SettingsSection tab="network" title="Connection" dirty={dirtyIds.has('port') || dirtyIds.has('connection')}>
		<form method="POST" action="?/network" class="rows" bind:this={forms.port} onsubmit={onSectionSubmit}>
			<div class="field">
				<label for="serverPort">Game port <span class="tag warn">restart</span></label>
				<input id="serverPort" name="serverPort" type="number" min="1" max="65535" bind:value={sv.serverPort} />
				<p class="hint">Written to server.properties too.</p>
			</div>
		</form>
		{@render propertyForm('connection')}
	</SettingsSection>

	<SettingsSection tab="network" title="RCON" description="MineShell sends console commands over RCON. Do not expose its port." dirty={dirtyIds.has('rcon')}>
		<form method="POST" action="?/network" class="rows" bind:this={forms.rcon} onsubmit={onSectionSubmit}>
			<div class="field">
				<label for="rconPort">RCON port <span class="tag warn">restart</span></label>
				<input id="rconPort" name="rconPort" type="number" min="1" max="65535" bind:value={sv.rconPort} />
			</div>
			<div class="field">
				<span class="label">RCON password</span>
				<div class="control secret-row">
					<code class="secret">{showRcon ? (data.rconPassword ?? 'not set') : '••••••••••••'}</code>
					<button class="button-quiet" type="button" onclick={() => (showRcon = !showRcon)}>{showRcon ? 'Hide' : 'Show'}</button>
				</div>
				<p class="hint">Generated when the server was created and stored encrypted.</p>
			</div>
			<div class="check field">
				<input id="rotateRcon" name="rotateRcon" type="checkbox" bind:checked={rotateRcon} />
				<label for="rotateRcon">Generate a new password on save</label>
			</div>
		</form>
	</SettingsSection>

	<!-- ======================================================== Performance -->

	<SettingsSection tab="performance" title="Distances" description="The biggest lever on CPU and memory use." dirty={dirtyIds.has('distances')}>
		{@render propertyForm('distances')}
	</SettingsSection>

	<SettingsSection tab="performance" title="Ticking and disk" dirty={dirtyIds.has('ticking')}>
		{@render propertyForm('ticking')}
	</SettingsSection>

	<SettingsSection tab="performance" title="Resource limits" dirty={dirtyIds.has('limits')}>
		{#snippet description()}
			Caps systemd puts on the server process. The kernel kills the server past the memory limit (crash restarts then
			apply), so leave Java room above its {s.memoryMaxMb} MB heap. The CPU limit slows it down instead: 100% is one full
			core, {data.cpuCores * 100}% all of them. Blank means no limit.
		{/snippet}
		<form method="POST" action="?/limits" class="rows" bind:this={forms.limits} onsubmit={onSectionSubmit}>
			<div class="field">
				<label for="limitMemoryMb">Memory limit (MB) <span class="tag warn">restart</span></label>
				<input
					id="limitMemoryMb"
					name="limitMemoryMb"
					type="number"
					min={(s.memoryMaxMb ?? 0) + 512}
					step="256"
					placeholder="No limit"
					bind:value={sv.limitMemoryMb}
				/>
				<p class="hint">
					At least {(s.memoryMaxMb ?? 0) + 512} MB; around {Math.ceil(((s.memoryMaxMb ?? 0) * 1.25) / 256) * 256} MB is
					comfortable.
				</p>
			</div>
			<div class="field">
				<label for="limitCpuPercent">CPU limit (%) <span class="tag warn">restart</span></label>
				<input
					id="limitCpuPercent"
					name="limitCpuPercent"
					type="number"
					min="10"
					max={data.cpuCores * 100}
					step="10"
					placeholder="No limit"
					bind:value={sv.limitCpuPercent}
				/>
			</div>
		</form>
	</SettingsSection>

	<!-- ====================================================== Java & memory -->

	<form method="POST" action="?/runtime" bind:this={forms.runtime} onsubmit={onSectionSubmit}>
		<SettingsSection tab="java" title="Runtime" dirty={dirtyIds.has('runtime')}>
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

		<SettingsSection tab="java" title="Memory" dirty={dirtyIds.has('runtime')}>
			<div class="rows">
				<div class="field">
					<label for="memoryMaxMb">Maximum memory (MB) <span class="tag warn">restart</span></label>
					<input id="memoryMaxMb" name="memoryMaxMb" type="number" min="512" step="256" bind:value={sv.memoryMaxMb} />
				</div>
				<div class="field">
					<label for="memoryMinMb">Starting memory (MB) <span class="tag warn">restart</span></label>
					<input id="memoryMinMb" name="memoryMinMb" type="number" min="256" step="256" bind:value={sv.memoryMinMb} />
				</div>
			</div>
		</SettingsSection>

		<SettingsSection tab="java" title="JVM flags" dirty={dirtyIds.has('runtime')}>
			<div class="rows">
				<div class="field">
					<label for="applyPreset">Flag preset</label>
					<select id="applyPreset" name="applyPreset" bind:value={presetToApply}>
						<option value="">Keep the current flags</option>
						{#each data.jvmPresets as preset (preset.id)}
							<option value={preset.id}>{preset.name}{preset.builtIn ? '' : ' (saved)'}</option>
						{/each}
					</select>
					{#if presetToApply}
						{@const chosen = data.jvmPresets.find((p) => p.id === presetToApply)}
						{#if chosen}
							<p class="hint">{chosen.description} Saving replaces the arguments below; memory flags come from Memory either way.</p>
						{/if}
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

	<SettingsSection tab="java" title="Saved presets" description="Flags you saved for reuse on any server.">
		<div class="block">
			{#if showSavePreset}
				<form method="POST" action="?/savePreset" use:enhance class="inline-row">
					<input type="hidden" name="jvmArgs" value={sv.jvmArgs} />
					<input name="presetName" bind:value={presetName} placeholder="Preset name, e.g. My tuning" aria-label="Preset name" />
					<button class="button-primary" type="submit">Save preset</button>
					<button type="button" class="button-quiet" onclick={() => (showSavePreset = false)}>Cancel</button>
				</form>
				<p class="hint">Saves the current flags (without <code>-Xms</code>/<code>-Xmx</code>).</p>
			{:else}
				<button type="button" onclick={() => (showSavePreset = true)}>Save current flags as a preset</button>
			{/if}
			{#if data.jvmPresets.some((p) => !p.builtIn)}
				<ul class="saved-presets">
					{#each data.jvmPresets.filter((p) => !p.builtIn) as preset (preset.id)}
						<li>
							<span>{preset.name}</span>
							<form method="POST" action="?/deletePreset" use:enhance>
								<input type="hidden" name="presetId" value={preset.id} />
								<button class="button-quiet" type="submit">Delete</button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</SettingsSection>

	<!-- ========================================================= Automation -->

	<SettingsSection tab="automation" title="Restarts" dirty={dirtyIds.has('restarts')}>
		<form method="POST" action="?/restarts" class="rows" bind:this={forms.restarts} onsubmit={onSectionSubmit}>
			<RestartFields bind:values={sv} />
		</form>
	</SettingsSection>

	<SettingsSection tab="automation" title="Scheduled commands" description="Console commands run on a schedule while the server is running.">
		<div class="table-box commands">
			{#if data.scheduledCommands.length}
				<table>
					<thead>
						<tr><th>Command</th><th>When</th><th>Next</th><th>Last run</th><th><span class="visually-hidden">Actions</span></th></tr>
					</thead>
					<tbody>
						{#each data.scheduledCommands as c (c.id)}
							<tr class:paused={!c.enabled}>
								<td class="mono small wrap">{c.command}</td>
								<td class="small nowrap">
									{c.everyMinutes
										? c.everyMinutes % 60 === 0
											? `every ${c.everyMinutes / 60} h`
											: `every ${c.everyMinutes} min`
										: `daily at ${c.dailyTime}`}
								</td>
								<td class="small nowrap">{c.enabled && c.nextAt ? formatTime(c.nextAt) : 'paused'}</td>
								<td class="small">
									{#if c.lastRunAt}
										{formatTime(c.lastRunAt)}
										<div class="faint mono wrap" class:warn-text={c.lastResult?.startsWith('Failed')}>{c.lastResult}</div>
									{:else}
										<span class="faint">never</span>
									{/if}
								</td>
								<td class="right nowrap">
									<form method="POST" action="?/toggleCommand" use:enhance class="inline">
										<input type="hidden" name="id" value={c.id} />
										<input type="hidden" name="enabled" value={String(!c.enabled)} />
										<button class="button-quiet" type="submit">{c.enabled ? 'Pause' : 'Resume'}</button>
									</form>
									<form method="POST" action="?/removeCommand" use:enhance class="inline">
										<input type="hidden" name="id" value={c.id} />
										<button class="button-quiet" type="submit">Remove</button>
									</form>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
			<form method="POST" action="?/addCommand" use:enhance class="add-command">
				<input name="command" class="mono grow" placeholder="say Remember to vote!" aria-label="Command" required />
				<select name="mode" bind:value={commandMode} aria-label="When">
					<option value="interval">Every</option>
					<option value="daily">Daily at</option>
				</select>
				{#if commandMode === 'daily'}
					<input name="dailyTime" type="time" value="04:00" aria-label="Time of day" required />
				{:else}
					<input name="everyMinutes" type="number" min="1" value="60" aria-label="Minutes" class="minutes" required />
					<span class="faint small">min</span>
				{/if}
				<button type="submit">Add</button>
			</form>
		</div>
		<p class="faint small after">
			Added, paused and removed straight away; these don't wait for Save. To pre-generate only at night, schedule
			<code>chunky continue</code> and <code>chunky pause</code>.
		</p>
	</SettingsSection>

	<!-- ========================================================== Snapshots -->

	<SettingsSection tab="snapshots" title="World snapshots" dirty={dirtyIds.has('snapshots')}>
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

	<!-- =========================================================== Advanced -->

	<SettingsSection tab="advanced" title="Console" dirty={dirtyIds.has('console')}>
		<form method="POST" action="?/console" class="rows" bind:this={forms.console} onsubmit={onSectionSubmit}>
			<ConsoleFields bind:values={sv} />
		</form>
	</SettingsSection>

	<SettingsSection
		tab="advanced"
		title="Other keys"
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

	<SettingsSection tab="advanced" title="Raw file" description="Edit server.properties directly. Saved as-is; comments and ordering are not kept.">
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
	<span>
		{#if dirty.length}
			{dirty.length} section{dirty.length === 1 ? '' : 's'} changed across {dirtyTabs.size} tab{dirtyTabs.size === 1 ? '' : 's'}
			{#if needsRestart}<span class="muted">· needs a restart</span>{/if}
		{:else}
			No unsaved changes
		{/if}
	</span>
	{#if dirty.length}
		<div class="button-row">
			<button type="button" class="button-quiet" onclick={discard} disabled={saving}>Discard</button>
			{#if needsRestart}
				<button type="button" onclick={() => save(false)} disabled={saving}>Save, restart later</button>
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
	.subhead {
		flex-wrap: nowrap;
	}

	.subhead .subtabs {
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.subhead .sep {
		width: 1px;
		height: 18px;
		align-self: center;
		margin: 0 0.6rem;
		background: var(--line-strong);
	}

	.search {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 13rem;
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

	/* ---- rows: label and help on the left, the control on the right. The
	   shared field components (PropertyInput, RestartFields, ConsoleFields,
	   SnapshotPolicyFields) keep their markup; this lays it out. */

	.rows {
		display: flex;
		flex-direction: column;
		margin-top: 0.4rem;
	}

	.rows :global(.grid-2),
	.rows :global(.policy) {
		display: contents;
	}

	.rows :global(fieldset) {
		border: 0;
		padding: 0;
		margin: 0;
		display: contents;
	}

	.rows :global(legend) {
		display: block;
		padding: 1.2rem 0 0.2rem;
		font-size: 0.8rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.rows :global(.field) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(9rem, 20rem);
		column-gap: 2rem;
		row-gap: 0.2rem;
		align-items: center;
		margin: 0;
		padding: 0.85rem 0;
		border-bottom: 1px solid var(--panel-raised);
	}

	.rows :global(.field > label),
	.rows :global(.field > .label),
	.rows :global(.field .check > label) {
		grid-column: 1;
		grid-row: 1;
		margin: 0;
		font-size: 0.95rem;
		font-weight: 500;
		color: var(--text);
	}

	.rows :global(.field > input),
	.rows :global(.field > select),
	.rows :global(.field > .control),
	.rows :global(.field .check > input) {
		grid-column: 2;
		grid-row: 1 / span 2;
		justify-self: end;
	}

	.rows :global(.field > input:not([type='checkbox'])),
	.rows :global(.field > select) {
		width: 100%;
	}

	.rows :global(.field > input[type='number']) {
		max-width: 8rem;
		text-align: right;
	}

	.rows :global(.field > .hint),
	.rows :global(.field > p) {
		grid-column: 1;
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.rows :global(.field .check) {
		display: contents;
	}

	/* Wide controls (text areas) go under the label instead. */
	.rows :global(.field.wide),
	.rows :global(.field:has(> textarea)) {
		grid-template-columns: minmax(0, 1fr);
	}

	.rows :global(.field.wide > input),
	.rows :global(.field > textarea) {
		grid-column: 1;
		grid-row: auto;
		justify-self: stretch;
		width: 100%;
	}

	/* Checkboxes in rows are switches. */
	.rows :global(input[type='checkbox']) {
		appearance: none;
		width: 40px;
		height: 22px;
		margin: 0;
		border-radius: 11px;
		cursor: pointer;
		background: var(--line-strong) radial-gradient(circle at 11px 11px, var(--text) 7px, transparent 7.5px) no-repeat;
		background-position: 0 0;
		transition:
			background-position 0.12s,
			background-color 0.12s;
	}

	.rows :global(input[type='checkbox']:checked) {
		background-color: var(--accent);
		background-position: 18px 0;
	}

	.rows :global(.field.changed > label::before) {
		content: '';
		display: inline-block;
		width: 6px;
		height: 6px;
		margin-right: 0.45rem;
		vertical-align: middle;
		border-radius: 1px;
		background: var(--warning);
	}

	.rows > :global(p.faint),
	.rows :global(.policy > fieldset > p.faint) {
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

	/* ---- blocks: things with their own buttons */

	.block {
		margin-top: 0.9rem;
		padding: var(--space-4);
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
	}

	.embedded :global(.panel) {
		margin-top: 0.9rem;
	}

	.inline-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.inline-row select,
	.inline-row input {
		width: auto;
		min-width: 16rem;
	}

	.icon-block {
		display: flex;
		align-items: center;
		gap: 1.1rem;
	}

	.icon-block img,
	.icon-placeholder {
		width: 64px;
		height: 64px;
		flex: none;
		border-radius: var(--radius);
		image-rendering: pixelated;
	}

	.icon-placeholder {
		display: grid;
		place-items: center;
		border: 1px dashed var(--line-strong);
		color: var(--text-muted);
	}

	.grow {
		flex: 1;
		margin: 0;
	}

	.danger-box {
		margin-top: 0.9rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		overflow: hidden;
	}

	.danger-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		padding: 0.9rem var(--space-4);
		background: var(--panel);
	}

	.danger-row.bad {
		background: color-mix(in srgb, var(--error) 5%, var(--panel));
		border-top: 1px solid color-mix(in srgb, var(--error) 25%, transparent);
	}

	.strong {
		font-weight: 500;
	}

	.danger-form {
		padding: var(--space-3) var(--space-4) var(--space-4);
		background: var(--panel);
	}

	.danger-form.bad {
		background: color-mix(in srgb, var(--error) 5%, var(--panel));
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

	.commands {
		margin-top: 0.9rem;
	}

	.commands .paused td {
		opacity: 0.6;
	}

	.commands form.inline {
		display: inline;
	}

	.add-command {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		background: color-mix(in srgb, var(--bg-sunken) 40%, var(--panel));
		border-top: 1px solid var(--line);
	}

	.add-command > * {
		width: auto;
	}

	.add-command .grow {
		flex: 1 1 14rem;
	}

	.add-command .minutes {
		width: 5rem;
	}

	.after {
		margin: var(--space-2) 0 0;
	}

	.raw textarea {
		font-family: var(--font-mono);
		font-size: 0.8rem;
		line-height: 1.7;
		margin-bottom: var(--space-3);
	}

	textarea.mono,
	input.mono {
		font-family: var(--font-mono);
		font-size: 0.82rem;
	}

	textarea:disabled {
		opacity: 0.5;
	}

	.right {
		text-align: right;
	}

	.wrap {
		overflow-wrap: anywhere;
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

	@media (max-width: 60rem) {
		.savebar {
			margin: 0 calc(var(--space-4) * -1) calc(var(--space-4) * -1);
			padding: 0.75rem var(--space-4);
		}

		.rows :global(.field) {
			grid-template-columns: minmax(0, 1fr);
		}

		.rows :global(.field > input),
		.rows :global(.field > select),
		.rows :global(.field > .control),
		.rows :global(.field .check > input) {
			grid-column: 1;
			grid-row: auto;
			justify-self: start;
		}
	}
</style>
