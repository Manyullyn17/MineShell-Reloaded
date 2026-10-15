<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';
	import { CLEANROOM_GUIDE_URL } from '#lib/shared/cleanroom.js';
	import SettingsSection from '#lib/components/SettingsSection.svelte';
	import CleanroomOption from '#lib/components/CleanroomOption.svelte';
	import SnapshotChoice from '#lib/components/SnapshotChoice.svelte';
	import JavaPrompt from '#lib/components/JavaPrompt.svelte';
	import type { ActionData, PageData } from './$types';

	let {
		cleanroom: cr,
		report: reportPromise,
		javaMajors,
		snapshotPrompt,
		form,
		editable
	}: {
		cleanroom: NonNullable<PageData['cleanroom']>;
		report: PageData['cleanroomReport'];
		javaMajors: number[];
		snapshotPrompt: PageData['snapshotPrompt'];
		form: ActionData;
		editable: boolean;
	} = $props();
</script>

<SettingsSection tab="general" title="Cleanroom" {editable}>
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
		{#await reportPromise}
			<p class="muted small">Checking mods against Cleanroom's guide.</p>
		{:then report}
			{#if report}
				{@const missing = report.required.filter((r) => !r.present)}
				{#if report.disable.length || missing.length}
					<div class="report">
						<h3>{cr.onCleanroom ? 'Still needs fixing' : 'Migrating will'}</h3>
						<ul>
							{#each report.replace as item (item.fileName)}
								<li>
									Replace <strong>{item.label}</strong> <code>{item.fileName}</code>
									<span class="muted">- it does not run on this Cleanroom version. {item.reason}</span>
								</li>
							{/each}
							{#each missing.filter((m) => !report.replace.some((r) => r.label === m.label)) as mod (mod.label)}
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
						<SnapshotChoice prompt={snapshotPrompt} idPrefix="revert" />
						<button type="submit" disabled={cr.running}>Revert to Forge</button>
					</form>
				{/if}
			</div>
		{:else}
			<form method="POST" action="?/migrateCleanroom" use:enhance>
				<CleanroomOption {javaMajors} toggle={false} idPrefix="migrate-cleanroom" />
				<SnapshotChoice prompt={snapshotPrompt} idPrefix="migrate" />
				<JavaPrompt {form} action="migrateCleanroom" />
				<button class="button-primary" type="submit" disabled={cr.running}>Migrate to Cleanroom</button>
			</form>
		{/if}
	</div>
</SettingsSection>

<style>
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
</style>
