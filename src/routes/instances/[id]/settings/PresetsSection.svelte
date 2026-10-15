<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { actionMessage, postAction } from '#lib/shared/forms.js';
	import SettingsSection from '#lib/components/SettingsSection.svelte';

	/** `jvmArgs`: the flags in the JVM flags box, saved or not. */
	let { jvmArgs }: { jvmArgs: string } = $props();

	let presetName = $state('');
	let showSavePreset = $state(false);

	// Presets belong to every server, so they are saved through MineShell settings' action.
	let presetMessage = $state<{ ok: boolean; message: string } | null>(null);
	async function savePreset(event: SubmitEvent) {
		event.preventDefault();
		const body = new FormData();
		body.set('presetName', presetName);
		body.set('jvmArgs', jvmArgs);
		const result = await postAction('/settings?/savePreset', body);
		presetMessage = { ok: result.type === 'success', message: actionMessage(result, 'Could not save that preset.') };
		if (result.type === 'success') {
			showSavePreset = false;
			presetName = '';
			await invalidateAll();
		}
	}
</script>

<SettingsSection tab="java" title="Saved presets" description="Flags you saved for reuse on any server.">
	<div class="block">
		{#if showSavePreset}
			<form class="inline-row" onsubmit={savePreset}>
				<input name="presetName" bind:value={presetName} placeholder="Preset name, e.g. My tuning" aria-label="Preset name" />
				<button class="button-primary" type="submit">Save preset</button>
				<button type="button" class="button-quiet" onclick={() => (showSavePreset = false)}>Cancel</button>
			</form>
			<p class="hint">Saves the current flags (without <code>-Xms</code>/<code>-Xmx</code>).</p>
		{:else}
			<button type="button" onclick={() => (showSavePreset = true)}>Save current flags as a preset</button>
		{/if}
		{#if presetMessage}<p class="hint" class:warn-text={!presetMessage.ok}>{presetMessage.message}</p>{/if}
		<p class="hint">Saved presets are shared by every server; delete them in <a href="/settings?tab=java">MineShell settings</a>.</p>
	</div>
</SettingsSection>

<style>
	.warn-text {
		color: var(--warning);
	}
</style>
