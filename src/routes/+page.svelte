<script lang="ts">
	import { enhance } from '$app/forms';
	import { refreshAll } from '$app/navigation';
	import StatusPill from '#lib/components/StatusPill.svelte';
	import Flash from '#lib/components/Flash.svelte';
	import { describeState, formatBytes, formatDuration, formatRelative } from '#lib/shared/format.js';

	let { data, form } = $props();

	let busy = $state<string | null>(null);

	// Systemd state changes a second or two after the button click, so the page
	// re-reads itself on a slow tick rather than pretending it is instant.
	$effect(() => {
		const timer = setInterval(() => void refreshAll(), 5000);
		return () => clearInterval(timer);
	});

	/** Something on the card asks to be looked at: a crash, a failed setup, a warning. */
	const needsAttention = (instance: (typeof data.instances)[number]) =>
		describeState(instance.active, instance.sub).tone === 'failed' ||
		instance.status === 'failed' ||
		!!instance.statusMessage ||
		!instance.eulaAccepted ||
		!!instance.javaWarning;
	const attention = $derived(data.instances.filter(needsAttention).length);

	// The page reloads every few seconds, each time with a new pending promise;
	// keeping the last answer stops the line flashing back to its loading text.
	let causes = $state<Record<string, string>>({});
	$effect(() => {
		let current = true;
		data.causes.then((found) => current && (causes = found)).catch(() => undefined);
		return () => (current = false);
	});

	function powerSubmit(id: string) {
		busy = id;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			busy = null;
		};
	}
</script>

<svelte:head><title>MineShell</title></svelte:head>

<header class="page-head">
	<div>
		<h1>Servers</h1>
		<p class="muted">
			{data.instances.length === 0
				? 'Nothing here yet.'
				: `${data.instances.filter((i) => i.running).length} of ${data.instances.length} running${attention ? ` · ${attention} need${attention === 1 ? 's' : ''} attention` : ''}`}
		</p>
	</div>
	<a class="button button-primary" href="/instances/new">Add a server</a>
</header>

<Flash {form} />

{#if !data.environment.systemdAvailable}
	<div class="notice error">
		<p>
			MineShell cannot reach the user's systemd instance, so servers cannot be started.
			{data.environment.systemdMessage}
		</p>
		<p>See <a href="/settings">MineShell settings</a> for what to check.</p>
	</div>
{:else if !data.environment.unitInstalled}
	<div class="notice warning">
		<p>
			The <code>minecraft@.service</code> template is not installed yet. Install it from
			<a href="/settings">MineShell settings</a> before starting a server.
		</p>
	</div>
{/if}

{#if data.environment.javaCount === 0}
	<div class="notice warning">
		<p>
			No Java runtime has been found on this machine. Install one, then rescan from
			<a href="/settings">MineShell settings</a>.
		</p>
	</div>
{/if}

{#if data.instances.length === 0}
	<div class="empty">
		<h2>Set up your first server</h2>
		<p>
			Start from a Modrinth or CurseForge modpack, or build one from a bare mod loader and add
			mods yourself.
		</p>
		<a class="button button-primary" href="/instances/new">Add a server</a>
	</div>
{:else}
	<div class="cards">
		{#each data.instances as instance (instance.id)}
			{@const tone = describeState(instance.active, instance.sub).tone}
			<article class="panel card" data-tone={tone}>
				<div class="card-head">
					<div class="title">
						<a href="/instances/{instance.id}"><h2>{instance.name}</h2></a>
						<div class="tags">
							<span class="tag">{instance.minecraftVersion}</span>
							<span class="tag accent">{instance.modloaderLabel}</span>
							<span class="tag">:{instance.port}</span>
						</div>
					</div>
					<div class="status">
						<StatusPill active={instance.active} sub={instance.sub} />
						<form method="POST" action="?/pin" use:enhance>
							<input type="hidden" name="id" value={instance.id} />
							<button
								class="pin hit-area"
								class:pinned={instance.pinned}
								type="submit"
								title={instance.pinned ? 'Unpin from the top' : 'Pin to the top'}
								aria-label={instance.pinned
									? `Unpin ${instance.name}`
									: `Pin ${instance.name} to the top`}
							>
								{instance.pinned ? '★' : '☆'}
							</button>
						</form>
					</div>
				</div>

				{#if instance.status === 'provisioning'}
					<p class="alert info">
						Still installing. Watch progress under <a href="/tasks">Activity</a>.
					</p>
				{:else if instance.status === 'failed'}
					<p class="alert error">Setup failed: {instance.statusMessage}</p>
				{:else if instance.statusMessage}
					<p class="alert warning">{instance.statusMessage}</p>
				{/if}

				{#if tone === 'failed' && instance.status === 'ready'}
					<p class="alert error">
						{instance.gaveUpAfter
							? `Crashed ${instance.gaveUpAfter} times in a row, so systemd stopped restarting it.`
							: 'The last run crashed.'}
						{#if causes[instance.id]}Likely cause: {causes[instance.id]}{:else}The overview shows the final output.{/if}
					</p>
				{/if}

				{#if !instance.eulaAccepted}
					<p class="alert warning">
						The Minecraft EULA has not been accepted for this server.
						<a href="/instances/{instance.id}">Review and accept it</a> to start.
					</p>
				{/if}

				{#if instance.javaWarning}
					<p class="alert warning">{instance.javaWarning}</p>
				{/if}

				<dl class="stats">
					<div>
						<dt>Uptime</dt>
						<dd class="mono">{instance.running ? formatDuration(instance.uptimeMs) : '-'}</dd>
					</div>
					<div>
						<dt>Players</dt>
						<dd class="mono">
							{instance.players ? `${instance.players.online}/${instance.players.max}` : '-'}
						</dd>
					</div>
					<div>
						<dt>Memory</dt>
						<dd class="mono">
							{instance.running && instance.memoryBytes ? formatBytes(instance.memoryBytes) : '-'}
						</dd>
					</div>
					<div>
						<dt>CPU</dt>
						<dd class="mono">
							{!instance.running || instance.cpuPercent === null ? '-' : `${instance.cpuPercent.toFixed(0)}%`}
						</dd>
					</div>
				</dl>

				{#if instance.players?.names.length}
					<p class="small muted online">Online: {instance.players.names.join(', ')}</p>
				{/if}

				<footer>
					<form method="POST" action="?/power" use:enhance={() => powerSubmit(instance.id)}>
						<input type="hidden" name="id" value={instance.id} />
						<div class="button-row">
							{#if instance.running}
								<button
									class="button-primary"
									name="verb"
									value="stop"
									disabled={busy === instance.id}
								>
									Stop
								</button>
								<button name="verb" value="restart" disabled={busy === instance.id}>Restart</button>
							{:else if tone === 'failed' && instance.status === 'ready'}
								<a class="button button-danger" href="/instances/{instance.id}">See what went wrong</a>
								<button name="verb" value="start" disabled={busy === instance.id}>Start</button>
							{:else}
								<button
									class="button-primary"
									name="verb"
									value="start"
									disabled={busy === instance.id || instance.status !== 'ready'}
								>
									Start
								</button>
							{/if}
							<a class="button" href="/instances/{instance.id}/console">Console</a>
						</div>
					</form>
					{#if instance.schedule !== 'Off'}
						<p class="small faint schedule">
							Scheduled restart: {instance.schedule.toLowerCase()}, next {formatRelative(
								instance.nextRestartAt
							)}
						</p>
					{/if}
				</footer>
			</article>
		{/each}
	</div>
{/if}

<style>
	.page-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-4);
		margin-bottom: var(--space-5);
		flex-wrap: wrap;
	}

	.page-head p {
		margin: var(--space-1) 0 0;
	}

	/* Explicit column count rather than auto-fit: on a wide screen auto-fit
	   happily fitted five 22rem columns into one row, which is not a useful
	   way to read a server list. Change --cards-per-row (here and in the two
	   breakpoints below) to adjust; a stored user preference would only need
	   to override this one value.

	   align-items: stretch, not start, so every card in a row shares the
	   tallest one's height - otherwise a card with fewer tags or no stats
	   ends short and the row looks ragged. */
	.cards {
		--cards-per-row: 3;
		display: grid;
		grid-template-columns: repeat(var(--cards-per-row), minmax(0, 1fr));
		gap: var(--space-4);
		align-items: stretch;
	}

	@media (max-width: 1200px) {
		.cards {
			--cards-per-row: 2;
		}
	}

	@media (max-width: 760px) {
		.cards {
			--cards-per-row: 1;
		}
	}

	.card {
		border-top: 3px solid var(--text-faint);
		padding: 1.1rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}

	/*
	 * .panel + .panel (in app.css) adds margin-top for panels stacked in
	 * normal document flow elsewhere in the app; it doesn't know these are
	 * grid siblings, and fires on every card except the first - exactly what
	 * made one card stretch taller than the rest under align-items: stretch.
	 * The grid's own gap already spaces these uniformly in both directions.
	 * A bare `.card { margin-top: 0 }` has lower specificity than
	 * `.panel + .panel` (one class vs. two) and would lose regardless of
	 * stylesheet order, so this three-class selector deliberately outranks it.
	 */
	.cards > .panel.card {
		margin-top: 0;
	}

	.card > :last-child {
		margin-top: auto;
	}

	.card[data-tone='running'] {
		border-top-color: var(--success);
	}
	.card[data-tone='failed'] {
		border-top-color: var(--error);
	}
	.card[data-tone='busy'] {
		border-top-color: var(--warning);
	}

	/* Pinning is what reorders this list, so the control belongs here rather
	   than only on a page where its effect is invisible. */
	.pin {
		background: none;
		border: 0;
		padding: 0 0.2rem;
		font-size: 1.05rem;
		line-height: 1;
		color: var(--text-faint);
	}

	.pin:hover {
		color: var(--accent-hover);
	}

	.pin.pinned {
		color: var(--accent);
	}

	.card-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.6rem;
	}

	.title {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		min-width: 0;
	}

	.title h2 {
		font-size: 1.1rem;
	}

	.status {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		flex: none;
	}

	.title a {
		text-decoration: none;
		color: var(--text);
	}

	.title a:hover h2 {
		color: var(--accent-hover);
	}

	.tags {
		display: flex;
		gap: var(--space-1);
		flex-wrap: wrap;
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: var(--space-2);
		margin: 0;
		padding: var(--space-3) 0;
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
	}

	.stats dt {
		font-size: 0.77rem;
		color: var(--text-faint);
	}

	.stats dd {
		margin: 0;
		font-size: 1rem;
	}

	.online {
		margin: 0;
	}

	.schedule {
		margin: var(--space-3) 0 0;
	}

	.alert {
		margin: 0;
		padding: 0.55rem var(--space-3);
		border-radius: var(--radius);
		font-size: 0.87rem;
	}
	.alert.error {
		color: color-mix(in srgb, var(--error) 70%, var(--text));
		background: color-mix(in srgb, var(--error) 10%, transparent);
	}
	.alert.warning {
		color: color-mix(in srgb, var(--warning) 80%, var(--text));
		background: color-mix(in srgb, var(--warning) 9%, transparent);
	}
	.alert.info {
		color: var(--text);
		background: color-mix(in srgb, var(--info) 10%, transparent);
	}

	.empty h2 {
		margin-bottom: var(--space-2);
	}

	.empty .button {
		margin-top: var(--space-3);
	}
</style>
