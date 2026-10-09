<script lang="ts">
	import type { SubmitFunction } from '$app/forms';
	import { enhance } from '#lib/shared/forms.js';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import StatusPill from '#lib/components/StatusPill.svelte';
	import Flash from '#lib/components/Flash.svelte';
	import { streamed } from '#lib/shared/streamed.svelte.js';

	let { data, children } = $props();

	// Streamed: whether Spark is installed (the first look opens every mod jar).
	const sparkInfo = streamed(() => data.spark, () => data.instance.id);
	const spark = $derived(sparkInfo.ready ? sparkInfo.value : null);
	const publicInfo = streamed(() => data.publicAddress, () => data.instance.id);
	const publicAddress = $derived(publicInfo.ready ? (publicInfo.value?.address ?? null) : null);

	const tabs = [
		{ slug: '', label: 'Overview' },
		{ slug: 'console', label: 'Console' },
		{ slug: 'logs', label: 'Logs' },
		{ slug: 'mods', label: 'Mods' },
		{ slug: 'world', label: 'World' },
		{ slug: 'map', label: 'Map' },
		{ slug: 'players', label: 'Players' },
		{ slug: 'files', label: 'Files' },
		{ slug: 'settings', label: 'Settings' }
	];

	const base = $derived(`/instances/${data.instance.id}`);
	const current = $derived(page.url.pathname.replace(base, '').replace(/^\//, ''));
	const isCurrent = (slug: string) => current === slug || (slug !== '' && current.startsWith(`${slug}/`));

	const actionUrl = (name: string) => `${base}?/${name}`;
	let menuOpen = $state(false);
	/** The menu opens toward the side with room: leftward from the ⋯ at the right of a desktop
	   header, rightward on a phone, where the header's buttons wrap to the left edge. */
	let menuWrap = $state<HTMLElement | null>(null);
	let menuFromLeft = $state(false);
	function toggleMenu() {
		if (!menuOpen && menuWrap) menuFromLeft = menuWrap.getBoundingClientRect().right < 16 * 16 + 16;
		menuOpen = !menuOpen;
	}
	let message = $state<{ ok?: boolean; message?: string } | null>(null);

	/**
	 * The header's forms post to the overview's actions from every tab. The
	 * default enhance would apply the result on the overview and navigate
	 * there, so the result is shown here and the data reloaded in place.
	 */
	const inPlace: SubmitFunction = () => {
		// Closed after the click: removing a menu item during it cancels the submit.
		setTimeout(() => (menuOpen = false));
		return async ({ result }) => {
			if (result.type === 'success' || result.type === 'failure') {
				message = (result.data as { ok?: boolean; message?: string }) ?? null;
			} else if (result.type === 'error') {
				message = { ok: false, message: result.error?.message ?? 'Something went wrong.' };
			}
			await invalidateAll();
		};
	};

	async function copyAddress(address = data.address) {
		await navigator.clipboard?.writeText(address).catch(() => undefined);
		message = { ok: true, message: `Copied ${address}.` };
		menuOpen = false;
	}

	const clock = (ms: number) => {
		const seconds = Math.max(0, Math.round(ms / 1000));
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	};
	let now = $state(Date.now());
	$effect(() => {
		if (!data.countdown) return;
		const tick = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(tick);
	});

	const delays = [1, 5, 10, 15];
	const canStart = $derived(data.instance.status === 'ready' && data.eulaAccepted);
</script>

<svelte:head><title>{data.instance.name} - MineShell</title></svelte:head>
<svelte:window onkeydown={(e) => e.key === 'Escape' && (menuOpen = false)} />

<div class="sticky-head">
	<header class="instance-head">
		<div class="identity">
			<div class="title">
				<h1>{data.instance.name}</h1>
				<StatusPill active={data.state.active} sub={data.state.sub} />
			</div>
			<div class="tags">
				<span class="tag">{data.instance.minecraftVersion}</span>
				<span class="tag accent">
					{data.instance.modloaderLabel}{data.instance.modloaderVersion
						? ` ${data.instance.modloaderVersion}`
						: ''}
				</span>
				<span class="tag">:{data.instance.serverPort}</span>
				{#if publicAddress}
					<button type="button" class="tag public-tag" title="Public through playit.gg: what players type. Click to copy." onclick={() => copyAddress(publicAddress)}>
						{publicAddress}
					</button>
				{/if}
				{#if data.instance.packName}
					<span class="tag">
						{data.instance.packName}{data.instance.packVersionName ? ` · ${data.instance.packVersionName}` : ''}
					</span>
				{/if}
			</div>
		</div>

		<form class="actions" method="POST" action={actionUrl('power')} use:enhance={inPlace}>
			{#if data.running}
				<button name="verb" value="restart">Restart</button>
				<button class="button-primary" name="verb" value="stop">Save and stop</button>
			{:else}
				<button class="button-primary" name="verb" value="start" disabled={!canStart}>Start</button>
			{/if}
			<div class="menu-wrap" bind:this={menuWrap}>
				<button
					type="button"
					class="more"
					aria-label="More actions"
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					onclick={toggleMenu}
				>
					⋯
				</button>
				{#if menuOpen}
					<button type="button" class="menu-scrim" aria-label="Close menu" onclick={() => (menuOpen = false)}></button>
					<div class="menu" class:from-left={menuFromLeft} role="menu">
						{#if data.running}
							<div class="menu-head">Stop with a warning</div>
							{#each delays as minutes (minutes)}
								<button
									type="submit"
									role="menuitem"
									name="verb"
									value="stop"
									formaction="{actionUrl('power')}&delay={minutes * 60}"
								>
									<span>Stop in {minutes} min</span><span class="hint">warns players</span>
								</button>
							{/each}
							<div class="menu-head">Restart with a warning</div>
							{#each delays as minutes (minutes)}
								<button
									type="submit"
									role="menuitem"
									name="verb"
									value="restart"
									formaction="{actionUrl('power')}&delay={minutes * 60}"
								>
									<span>Restart in {minutes} min</span><span class="hint">warns players</span>
								</button>
							{/each}
						{/if}
						<div class="menu-head">Server</div>
						<button type="button" role="menuitem" onclick={() => copyAddress()}>
							<span>Copy address</span><span class="hint mono">{data.address}</span>
						</button>
						{#if publicAddress}
							<button type="button" role="menuitem" onclick={() => copyAddress(publicAddress)}>
								<span>Copy public address</span><span class="hint mono">{publicAddress}</span>
							</button>
						{/if}
						<button type="submit" role="menuitem" formaction={actionUrl('pin')}>
							<span>{data.instance.pinned ? 'Unpin from the top of the list' : 'Pin to top of list'}</span>
						</button>
						{#if spark && data.running && !spark.active}
							<button type="submit" role="menuitem" formaction={actionUrl('profile')} name="seconds" value="60">
								<span>Start a Spark profile</span><span class="hint">60 s</span>
							</button>
						{/if}
						<a role="menuitem" href="{base}/console" onclick={() => (menuOpen = false)}>
							<span>Open console</span>
						</a>
						<a role="menuitem" href="{base}/export" onclick={() => (menuOpen = false)}>
							<span>Export a client pack</span><span class="hint">Modrinth, CurseForge, Prism</span>
						</a>
						{#if data.running}
							<div class="menu-head">If it's stuck</div>
							<button type="submit" role="menuitem" class="danger" name="verb" value="kill">
								<span>Force stop</span><span class="hint">kills the process</span>
							</button>
						{/if}
					</div>
				{/if}
			</div>
		</form>
	</header>

	{#if data.countdown}
		<form class="countdown" method="POST" action={actionUrl('cancelCountdown')} use:enhance={inPlace}>
			<span class="dot busy"></span>
			<span>
				{data.countdown.verb === 'stop' ? 'Stopping' : 'Restarting'} in
				<strong class="mono">{clock(data.countdown.at - now)}</strong>; players have been warned.
			</span>
			<button class="button-quiet" type="submit">Cancel</button>
		</form>
	{/if}

	<nav class="tabs" aria-label="Server sections">
		{#each tabs as tab (tab.slug)}
			<a href={tab.slug ? `${base}/${tab.slug}` : base} aria-current={isCurrent(tab.slug) ? 'page' : undefined}>
				{tab.label}
			</a>
		{/each}
	</nav>
</div>

{#if message}
	<Flash form={message} />
{/if}

{@render children()}

<style>
	/* Header and tabs stay visible while the content below scrolls. Both live in
	   one sticky wrapper so they never separate mid-scroll, with a background
	   so page content does not show through. */
	.sticky-head {
		position: sticky;
		top: 3.25rem;
		z-index: 15;
		background: var(--bg);
		margin: calc(var(--space-5) * -1) -2.5rem var(--space-5);
		padding: 1.1rem 2.5rem 0;
	}

	.instance-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		margin-bottom: var(--space-3);
	}

	.identity {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		min-width: 0;
	}

	.title {
		display: flex;
		align-items: center;
		gap: 0.9rem;
		flex-wrap: wrap;
	}

	.tags {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	/* The public address, a tag that copies itself. */
	.public-tag {
		background: none;
		color: var(--accent-hover);
		border-color: color-mix(in srgb, var(--accent) 50%, transparent);
		cursor: pointer;
		font-weight: normal;
	}

	.actions {
		display: flex;
		gap: var(--space-2);
		flex: none;
	}

	.more {
		color: var(--text-muted);
		padding-inline: 0.7rem;
	}

	.menu-wrap {
		position: relative;
	}

	.menu-scrim {
		position: fixed;
		inset: 0;
		z-index: 30;
		background: transparent;
		border: 0;
		padding: 0;
		cursor: default;
	}

	.menu {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		z-index: 31;
		width: 16rem;
		max-height: 70vh;
		overflow-y: auto;
		background: var(--panel-raised);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-lg);
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
		padding: 5px;
	}

	.menu.from-left {
		right: auto;
		left: 0;
		max-width: calc(100vw - 2rem);
	}

	.menu-head {
		padding: 0.5rem 0.6rem 0.25rem;
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.menu-head:not(:first-child) {
		border-top: 1px solid var(--line-strong);
		margin-top: 0.25rem;
	}

	.menu [role='menuitem'] {
		display: flex;
		justify-content: space-between;
		gap: 0.6rem;
		width: 100%;
		padding: 0.45rem 0.6rem;
		border: 0;
		border-radius: var(--radius);
		background: none;
		color: var(--text);
		font-size: 0.88rem;
		font-weight: 400;
		text-align: left;
		text-decoration: none;
	}

	.menu [role='menuitem']:hover {
		background: color-mix(in srgb, var(--text) 8%, transparent);
	}

	.menu .danger {
		color: var(--error);
	}

	.menu .hint {
		font-size: 0.78rem;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.countdown {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-bottom: var(--space-3);
		padding: 0.35rem var(--space-3);
		border-radius: var(--radius);
		font-size: 0.88rem;
		color: var(--warning);
		background: color-mix(in srgb, var(--warning) 8%, transparent);
	}

	.countdown button {
		margin-left: auto;
	}

	.tabs {
		display: flex;
		gap: var(--space-1);
		border-bottom: 1px solid var(--line);
		overflow-x: auto;
		overflow-y: hidden;
		overscroll-behavior-x: contain;
	}

	.tabs a {
		padding: 0.6rem 0.9rem;
		color: var(--text-muted);
		text-decoration: none;
		border-bottom: 2px solid transparent;
		white-space: nowrap;
		font-size: 0.95rem;
	}

	.tabs a:hover {
		color: var(--text);
	}

	.tabs a[aria-current='page'] {
		color: var(--text);
		border-bottom-color: var(--accent);
	}

	@media (max-width: 60rem) {
		.tabs {
		/* Fades out at the right edge, so it reads as "scrolls for more"; the padding lets the last tab scroll clear of it. */
		mask-image: linear-gradient(to right, #000 calc(100% - 2rem), transparent);
		padding-right: 2rem;
		}

		/* On a phone the header and tabs are most of the screen: they scroll away. */
		.sticky-head {
			position: static;
			margin: calc(var(--space-4) * -1) calc(var(--space-4) * -1) var(--space-5);
			padding: var(--space-4) var(--space-4) 0;
		}
	}
</style>
