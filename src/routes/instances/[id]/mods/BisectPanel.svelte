<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '#lib/shared/forms.js';
	import type { PageData } from './$types';

	/**
	 * The mod bisect assistant: a running or finished search, or the form that
	 * starts one. Stays mounted while another sub-tab is open (`active` false),
	 * so the form keeps what was picked.
	 */
	let {
		active,
		bisect: info,
		mods,
		running,
		mayMods,
		mayStart
	}: {
		active: boolean;
		bisect: PageData['bisect'];
		mods: PageData['mods'];
		running: boolean;
		mayMods: boolean;
		/** Changes mods and starts the server, so needs both. */
		mayStart: boolean;
	} = $props();

	const bisect = $derived(info.state);
	let bisectOpen = $state(false);
	let keepFilter = $state('');
	/** Mods kept on during the search, by file name; Cleanroom's own fixes start ticked. */
	let keepOn = $state<string[]>([]);
	$effect(() => {
		const defaults = info.keepByDefault;
		untrack(() => {
			if (!keepOn.length) keepOn = [...defaults];
		});
	});
	const enabledMods = $derived(mods.filter((m) => m.enabled && !m.missing));
	const suspectCount = $derived(enabledMods.filter((m) => !keepOn.includes(m.fileName)).length);
	const estimate = $derived(suspectCount <= 1 ? 2 : 2 + Math.ceil(Math.log2(suspectCount)));
	const modName = (file: string) => mods.find((m) => m.fileName === file || m.fileName === `${file}.disabled`)?.name ?? file;
</script>

{#if !active}
	<!-- Kept mounted, shown on the Installed tab only. -->
{:else if bisect}
	<section class="panel bisect">
		{#if info.running}
			<div class="panel-head">
				<div>
					<h2>Searching for the mod behind the crash</h2>
					<p>
						Test {bisect.tests.length + 1} of about {bisect.estimate} · {bisect.remaining} suspect{bisect.remaining === 1 ? '' : 's'} left of
						{bisect.suspects}. The server starts on a throwaway world; yours is not touched.
					</p>
				</div>
				{#if mayMods}
					<form method="POST" action="?/bisectCancel" use:enhance>
						<button type="submit" class="button-danger">Cancel</button>
					</form>
				{/if}
			</div>
			<div class="progress" role="progressbar" aria-valuenow={Math.round((bisect.tests.length / bisect.estimate) * 100)}>
				<span style="width: {Math.min(100, (bisect.tests.length / bisect.estimate) * 100)}%"></span>
			</div>
		{:else}
			<div class="panel-head">
				<h2>
					{bisect.status === 'found'
						? bisect.culprits.length === 1
							? 'Found the mod behind the crash'
							: 'Found the mods behind the crash, together'
						: bisect.status === 'cancelled'
							? 'Search cancelled'
							: 'The search did not find a mod'}
				</h2>
				{#if mayMods}
					<form method="POST" action="?/bisectDismiss" use:enhance>
						<button type="submit" class="button-quiet">Dismiss</button>
					</form>
				{/if}
			</div>
			{#if bisect.status === 'found'}
				<p class="small muted">
					{bisect.culprits.length === 1
						? 'The problem shows whenever it is on, and not without it.'
						: 'The problem shows only when these are on at the same time.'} Everything is back as it was; disable it here if you want it gone.
				</p>
				<ul class="culprits">
					{#each bisect.culprits as file (file)}
						<li>
							<span><strong>{modName(file)}</strong> <span class="faint small mono">{file}</span></span>
							{#if mods.some((m) => m.fileName === file) && mayMods}
								<form method="POST" action="?/toggle" use:enhance>
									<input type="hidden" name="fileName" value={file} />
									<input type="hidden" name="enabled" value="false" />
									<button type="submit">Disable</button>
								</form>
							{:else if !mods.some((m) => m.fileName === file)}
								<span class="faint small">disabled</span>
							{/if}
						</li>
					{/each}
				</ul>
			{:else if bisect.message}
				<p class="small muted">{bisect.message}</p>
			{/if}
		{/if}
		{#if bisect.tests.length}
			<details class="tests" open={info.running}>
				<summary class="small">{bisect.tests.length} test{bisect.tests.length === 1 ? '' : 's'}</summary>
				<ol>
					{#each bisect.tests as t, i (i)}
						<li class="small">
							<span class="dot" class:failed={t.result === 'problem'} class:running={t.result === 'fine'}></span>
							{t.enabled} on · {t.result === 'problem' ? 'the problem showed' : t.result === 'fine' ? 'fine' : 'repeated'}: {t.note}
						</li>
					{/each}
				</ol>
			</details>
		{/if}
	</section>
{:else if mayStart}
	<details class="bisect-start" bind:open={bisectOpen}>
		<summary>Find the mod behind a crash</summary>
		<form method="POST" action="?/bisect" use:enhance class="bisect-form">
			<p class="small muted">
				Starts the server again and again with fewer mods, halving the suspects each time, until the mod (or the pair of
				mods) the problem comes from is left. Every start uses a throwaway world, so yours is never opened with mods
				missing; mods, configs and settings are put back afterwards. About {estimate} starts for {suspectCount}
				suspects.
			</p>
			<div class="field">
				<label for="bisect-text">The problem (optional)</label>
				<input id="bisect-text" name="logText" placeholder="Text from the log, e.g. an error line" />
				<p class="hint">Empty: a crash before the server finishes starting. With text: a start fails when that text shows in the log.</p>
			</div>
			<div class="field">
				<span class="label-text">Keep these on ({keepOn.length})</span>
				<p class="hint">Mods you trust, like libraries: they stay on in every test, so fewer starts are needed.</p>
				<input type="search" placeholder="Filter" aria-label="Filter mods" bind:value={keepFilter} />
				<div class="keep-list">
					{#each enabledMods.filter((m) => !keepFilter || m.name.toLowerCase().includes(keepFilter.toLowerCase())) as m (m.fileName)}
						<label class="check">
							<input type="checkbox" name="keepOn" value={m.fileName} bind:group={keepOn} />
							<span>{m.name}</span>
						</label>
					{/each}
				</div>
			</div>
			<button type="submit" class="button-primary" disabled={running || suspectCount === 0}>
				{running ? 'Stop the server first' : 'Start the search'}
			</button>
		</form>
	</details>
{/if}

<style>
	.bisect {
		margin-bottom: var(--space-4);
	}

	.bisect .progress {
		margin: var(--space-2) 0;
	}

	.culprits {
		list-style: none;
		margin: var(--space-2) 0 0;
		padding: 0;
	}

	.culprits li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3);
		padding: 0.4rem 0;
		border-top: 1px solid var(--line);
	}

	.tests {
		margin-top: var(--space-2);
	}

	.tests ol {
		margin: var(--space-2) 0 0;
		padding-left: 1.4rem;
	}

	.tests li {
		margin: 0.15rem 0;
	}

	.tests .dot {
		display: inline-block;
		margin-right: 0.3rem;
	}

	.bisect-start {
		margin-bottom: var(--space-4);
	}

	.bisect-start summary {
		cursor: pointer;
		color: var(--text-muted);
	}

	.bisect-form {
		margin-top: var(--space-3);
		max-width: 44rem;
	}

	.keep-list {
		max-height: 14rem;
		overflow-y: auto;
		margin-top: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		display: grid;
		gap: 0.2rem;
	}

	.keep-list .check {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
	}
</style>
