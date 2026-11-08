<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';

	/**
	 * What crash diagnosis (crashdiag.ts) made of a run: the fatal causes with
	 * their one-click fix, and the errors the server carried on past.
	 */
	type Diagnosis = {
		title: string;
		detail: string;
		evidence: string;
		fatal: boolean;
		culprit?: { fileName: string; enabled: boolean } | null;
		related?: { fileName: string } | null;
		fix?: { fileName: string; enable: boolean; label: string } | null;
		install?: { modId: string; name: string } | null;
		/** Fugue does not fit this Cleanroom: "Install a matching Fugue". */
		matchFugue?: boolean;
		/** Its "Install" was pressed and the task still runs. */
		installing?: boolean;
		/** Fixed since the crash (the dependency is there now): nothing to press. */
		resolved?: boolean;
		tickLimit?: { ms: number; label: string } | null;
	};

	let {
		diagnosis,
		fixAction = null,
		installAction = null,
		matchFugueAction = null,
		tickLimitAction = null
	}: {
		diagnosis: Diagnosis[] | null | undefined;
		/** Where the fix buttons post (the overview's modFix); null hides them, e.g. while running. */
		fixAction?: string | null;
		/** Where a missing dependency's "Install" posts (the overview's installDependency); null hides it. */
		installAction?: string | null;
		/** Where "Install a matching Fugue" posts (the overview's matchFugue); null hides it. */
		matchFugueAction?: string | null;
		/** Where the watchdog's "allow longer ticks" posts (the overview's tickLimit); null hides it. */
		tickLimitAction?: string | null;
	} = $props();

	const fatal = $derived((diagnosis ?? []).filter((d) => d.fatal));
	const other = $derived((diagnosis ?? []).filter((d) => !d.fatal));
</script>

<!-- By position: without console access the evidence is empty, so title and evidence need not be unique. -->
{#each fatal as d, i (i)}
	<div class="diagnosis" class:resolved={d.resolved}>
		<strong>{d.title}</strong>
		<p>{d.detail}</p>
		{#if d.culprit}
			<p class="small muted">
				Mod file: <code>{d.culprit.fileName}</code>{d.culprit.enabled ? '' : ' (now disabled)'}
				{#if d.related}· related: <code>{d.related.fileName}</code>{/if}
			</p>
		{/if}
		{#if d.evidence}<p class="small muted evidence"><code>{d.evidence}</code></p>{/if}
		{#if (d.install || d.matchFugue) && d.installing}
			<p class="small">Installing {d.install?.name ?? 'Fugue'}; follow it in Activity. Start the server once it is done.</p>
		{:else if (d.install && installAction) || (d.matchFugue && matchFugueAction) || (d.fix && fixAction)}
			<div class="fixes">
				{#if d.install && installAction}
					<form method="POST" action={installAction} use:enhance>
						<input type="hidden" name="modId" value={d.install.modId} />
						<button type="submit" class="button-primary">Install {d.install.name}</button>
					</form>
				{/if}
				{#if d.matchFugue && matchFugueAction}
					<form method="POST" action={matchFugueAction} use:enhance>
						<button type="submit" class="button-primary">Install a matching Fugue</button>
					</form>
				{/if}
				{#if d.fix && fixAction}
					<form method="POST" action={fixAction} use:enhance>
						<input type="hidden" name="fileName" value={d.fix.fileName} />
						<input type="hidden" name="enable" value={String(d.fix.enable)} />
						<button type="submit">{d.fix.label}</button>
					</form>
				{/if}
			</div>
		{/if}
		{#if d.tickLimit && tickLimitAction}
			<form method="POST" action={tickLimitAction} use:enhance>
				<input type="hidden" name="ms" value={d.tickLimit.ms} />
				<button type="submit">{d.tickLimit.label}</button>
			</form>
		{/if}
	</div>
{/each}
{#if other.length}
	<details class="other-errors">
		<summary>
			{other.length} other error{other.length === 1 ? '' : 's'} earlier in this run (the server carried on past {other.length === 1 ? 'it' : 'them'}; often harmless)
		</summary>
		<ul>
			{#each other as d, i (i)}
				<li><strong>{d.title}</strong> <span class="muted">- {d.detail}</span></li>
			{/each}
		</ul>
	</details>
{/if}

<style>
	.diagnosis {
		border-left: 3px solid var(--error);
		padding: var(--space-2) var(--space-3);
		margin-bottom: var(--space-3);
		background: color-mix(in srgb, var(--error) 7%, transparent);
	}

	.diagnosis.resolved {
		border-left-color: var(--success);
		background: color-mix(in srgb, var(--success) 7%, transparent);
	}

	.diagnosis p {
		margin: var(--space-1) 0;
	}

	.diagnosis .evidence code {
		overflow-wrap: anywhere;
	}

	/* Install and disable side by side, wrapping on a narrow screen. */
	.fixes {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}

	/* Its label names the mod ("Disable ..."), which can be one long word. */
	.diagnosis button {
		max-width: 100%;
		white-space: normal;
		overflow-wrap: anywhere;
		text-align: left;
	}

	.other-errors {
		margin-bottom: var(--space-3);
		font-size: 0.88rem;
	}

	.other-errors ul {
		padding-left: 1.2rem;
	}
</style>
