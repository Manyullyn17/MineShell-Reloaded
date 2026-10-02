<script lang="ts">
	import {
		CLEANMIX_WARNING,
		CLEANROOM_GUIDE_URL,
		CLEANROOM_MINECRAFT,
		cleanroomJavaMajor,
		recommendedForForgePacks,
		usesCleanMix
	} from '$lib/shared/cleanroom';

	/**
	 * Cleanroom version picker with a Java check, shared by the pack install
	 * forms (as an opt-in checkbox) and the migration panel (always on).
	 * Submits `useCleanroom` (when toggleable) and `cleanroomVersion`.
	 */
	let {
		javaMajors,
		toggle = true,
		label = 'Run on Cleanroom instead of Forge',
		idPrefix = 'cleanroom'
	}: {
		/** Major versions of the Java runtimes found on this machine. */
		javaMajors: number[];
		toggle?: boolean;
		label?: string;
		idPrefix?: string;
	} = $props();

	// svelte-ignore state_referenced_locally
	let enabled = $state(!toggle);
	let versions = $state<string[]>([]);
	let version = $state('');
	let loading = $state(false);
	let loadError = $state('');

	$effect(() => {
		if (!enabled || versions.length || loading) return;
		loading = true;
		fetch(`/api/loaders/versions?loader=cleanroom&mc=${CLEANROOM_MINECRAFT}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error('lookup failed'))))
			.then((body) => {
				versions = body.versions ?? [];
				// This picker is only used for Forge packs, which mostly break on
				// CleanMix (0.6+), so start from the newest version before it.
				if (!version) version = recommendedForForgePacks(versions) ?? '';
			})
			.catch(() => (loadError = 'Could not reach the Cleanroom repository; the latest version will be used.'))
			.finally(() => (loading = false));
	});

	let requiredJava = $derived(cleanroomJavaMajor(version || null));
	let recommended = $derived(recommendedForForgePacks(versions));
	let javaMissing = $derived(!javaMajors.some((m) => m >= requiredJava));
</script>

<div class="cleanroom">
	{#if toggle}
		<div class="check field">
			<input id="{idPrefix}-use" name="useCleanroom" type="checkbox" bind:checked={enabled} />
			<label for="{idPrefix}-use">{label}</label>
		</div>
	{/if}

	{#if enabled}
		<div class="field">
			<label for="{idPrefix}-version">Cleanroom version</label>
			<select id="{idPrefix}-version" name="cleanroomVersion" bind:value={version} disabled={loading}>
				{#if loading}
					<option value="">Loading.</option>
				{:else}
					<option value="">Latest{versions[0] ? ` (${versions[0]})` : ''}</option>
					{#each versions.slice(0, 40) as v (v)}
						<option value={v}>{v}{v === recommended ? ' (recommended for Forge packs)' : ''}</option>
					{/each}
				{/if}
			</select>
			{#if loadError}
				<p class="hint">{loadError}</p>
			{/if}
			{#if !loading && usesCleanMix(version || null)}
				<p class="hint warn-text">{CLEANMIX_WARNING}</p>
			{/if}
			{#if javaMissing}
				<p class="hint warn-text">
					This Cleanroom version needs Java {requiredJava}, which was not found on this machine.
					Install it (<code>sudo apt install openjdk-{requiredJava}-jre-headless</code>) and rescan{requiredJava ===
					25
						? ', or pick a 0.4.x version, which runs on Java 21'
						: ''}.
				</p>
			{/if}
			<p class="hint">
				Fugue and Scalar Legacy are added, and mods
				<a href={CLEANROOM_GUIDE_URL} target="_blank" rel="noreferrer">Cleanroom's guide</a> lists as
				broken are disabled. Cleanroom is alpha software; keep a backup of anything you care about.
			</p>
		</div>
	{/if}
</div>

<style>
	.warn-text {
		color: var(--warning);
	}
</style>
