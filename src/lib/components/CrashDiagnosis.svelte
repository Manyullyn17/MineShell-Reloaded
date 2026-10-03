<script lang="ts">
	import { enhance } from '$app/forms';

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
	};

	let {
		diagnosis,
		fixAction = null
	}: {
		diagnosis: Diagnosis[] | null | undefined;
		/** Where the fix buttons post (the overview's modFix); null hides them, e.g. while running. */
		fixAction?: string | null;
	} = $props();

	const fatal = $derived((diagnosis ?? []).filter((d) => d.fatal));
	const other = $derived((diagnosis ?? []).filter((d) => !d.fatal));
</script>

{#each fatal as d (d.title + d.evidence)}
	<div class="diagnosis">
		<strong>{d.title}</strong>
		<p>{d.detail}</p>
		{#if d.culprit}
			<p class="small muted">
				Mod file: <code>{d.culprit.fileName}</code>{d.culprit.enabled ? '' : ' (now disabled)'}
				{#if d.related}· related: <code>{d.related.fileName}</code>{/if}
			</p>
		{/if}
		<p class="small muted evidence"><code>{d.evidence}</code></p>
		{#if d.fix && fixAction}
			<form method="POST" action={fixAction} use:enhance>
				<input type="hidden" name="fileName" value={d.fix.fileName} />
				<input type="hidden" name="enable" value={String(d.fix.enable)} />
				<button type="submit">{d.fix.label}</button>
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
			{#each other as d (d.title + d.evidence)}
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

	.diagnosis p {
		margin: var(--space-1) 0;
	}

	.diagnosis .evidence code {
		overflow-wrap: anywhere;
	}

	.other-errors {
		margin-bottom: var(--space-3);
		font-size: 0.88rem;
	}

	.other-errors ul {
		padding-left: 1.2rem;
	}
</style>
