<script lang="ts">
	import { enhance } from '#lib/shared/forms.js';

	/**
	 * A question Forge 1.12 (or Cleanroom) waits on while starting
	 * (forgequery.ts). It can only be answered on the console's input, which a
	 * service does not have, so MineShell answers by starting once more with
	 * the answer preset; "Stop" leaves the world untouched.
	 */
	type Question = {
		kind: 'missing-entries' | 'missing-registries' | 'backup-level-dat' | 'other';
		askedAt: number;
		text: string;
		groups: { name: string; entries: string[] }[];
	};

	let { question }: { question: Question } = $props();

	const count = $derived(question.groups.reduce((n, g) => n + g.entries.length, 0));
	let busy = $state(false);

	/** "minecraft:blocks" -> "Blocks"; a mod's own registry keeps its id. */
	const groupName = (name: string) =>
		name.startsWith('minecraft:') ? name.slice(10).replace(/^./, (c) => c.toUpperCase()).replace(/events$/, ' events') : name;

	const confirmLabel = $derived(
		question.kind === 'missing-entries' || question.kind === 'missing-registries'
			? 'Remove them and start'
			: question.kind === 'backup-level-dat'
				? 'Use the backup and start'
				: 'Confirm and start'
	);
</script>

<section class="panel question">
	{#if question.kind === 'missing-entries'}
		<h2>Forge is waiting: {count} block{count === 1 ? '' : 's'}, item{count === 1 ? '' : 's'} or other entr{count === 1 ? 'y is' : 'ies are'} missing</h2>
		<p>
			The world holds things no installed mod provides any more, usually after a pack update or a mod was removed. Forge
			will not load the world until someone decides. Removing them deletes those blocks from the world and those items
			from every chest and inventory, for good. If they went missing by mistake (a mod failed to download, or was
			disabled), stop instead and put the mod back.
		</p>
	{:else if question.kind === 'missing-registries'}
		<h2>Forge is waiting: {count} registr{count === 1 ? 'y is' : 'ies are'} missing</h2>
		<p>
			The world holds data for whole kinds of content that no installed mod registers any more, usually because the mod
			that added them was removed. Forge will not load the world until someone decides. Removing them drops that data
			from the world for good; if the mod went missing by mistake, stop instead and put it back.
		</p>
	{:else if question.kind === 'backup-level-dat'}
		<h2>Forge is waiting: the world's level.dat is damaged</h2>
		<p>
			level.dat could not be read, and Forge would load the world from its backup (level.dat_old) instead. That can
			lose recent progress, or damage the world if the backup is broken too. Forge recommends a world backup first.
		</p>
	{:else}
		<h2>Forge is waiting for an answer</h2>
		<p>Forge stopped loading the world to ask the question below.</p>
	{/if}
	<p class="muted small">
		Forge only takes an answer on the server's own console, which a background service does not have, and RCON is not
		listening yet. MineShell answers by starting the server once more with the answer preset (<code class="flag"
			>-Dfml.queryResult=confirm</code
		>), for that one start only.
	</p>

	{#if question.groups.length}
		<details>
			<summary>What is missing</summary>
			{#each question.groups as group (group.name)}
				<h3>{groupName(group.name)} <span class="muted">({group.entries.length})</span></h3>
				<ul class="entries">
					{#each group.entries as entry (entry)}
						<li><code>{entry}</code></li>
					{/each}
				</ul>
			{/each}
		</details>
	{/if}
	{#if question.kind === 'other' || question.kind === 'backup-level-dat'}
		<details open={question.kind === 'other'}>
			<summary>Forge's message</summary>
			<pre>{question.text}</pre>
		</details>
	{/if}

	<form
		method="POST"
		action="?/forgeAnswer"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				await update({ reset: false });
				busy = false;
			};
		}}
	>
		<div class="check">
			<input id="forge-snapshot" name="snapshot" type="checkbox" checked />
			<label for="forge-snapshot">Snapshot the world first</label>
		</div>
		{#if question.kind === 'missing-entries'}
			<p class="muted small">Forge also saves a zip of the world in the server folder before it removes anything.</p>
		{/if}
		<div class="buttons">
			<button class="button-primary" type="submit" name="answer" value="confirm" disabled={busy}>{confirmLabel}</button>
			<button type="submit" name="answer" value="cancel" disabled={busy}>Stop</button>
		</div>
	</form>
</section>

<style>
	.question {
		border-left: 3px solid var(--warning);
		margin-bottom: var(--space-4);
	}

	.question h2 {
		margin: 0 0 var(--space-2);
	}

	.question details {
		margin-bottom: var(--space-3);
	}

	.flag {
		white-space: nowrap;
	}

	.question h3 {
		font-size: 0.95rem;
		margin: var(--space-2) 0 var(--space-1);
	}

	.entries {
		columns: 2 18rem;
		padding-left: 1.2rem;
		margin: 0;
	}

	.entries code {
		overflow-wrap: anywhere;
	}

	pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
</style>
