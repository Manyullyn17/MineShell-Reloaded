<script lang="ts">
	/**
	 * Content is rendered as sanitized HTML now: `marked` parses the markdown,
	 * `DOMPurify` strips anything dangerous (scripts, event handlers, embedded
	 * iframes) before it ever reaches {@html}. Both run client-side, where a
	 * real DOM already exists - no server-side rendering step needed for this.
	 */
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';

	function renderMarkdown(text: string): string {
		// CurseForge's HTML-to-Markdown conversion leaves Pandoc-style image
		// attribute blocks after the image itself, e.g.
		// `![](url){width=1126 height=378}` - `marked` doesn't parse that
		// trailing `{...}`, so it shows up as literal text under the image
		// instead of being applied or dropped. The image already scales via
		// max-width: 100% below, so the attributes aren't needed - just strip
		// them rather than trying to reproduce them as real HTML attributes.
		const cleaned = text.replace(/(!\[[^\]]*\]\([^)]*\))\s*\{[^}]*\}/g, '$1');
		const html = marked.parse(cleaned, { async: false }) as string;
		return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
	}

	/**
	 * FTB's changelog field sometimes comes back as nothing but a link to
	 * view the changelog elsewhere, rather than the changelog text itself.
	 * Run through the same markdown pipeline, that just autolinks the bare
	 * URL with no surrounding context - a single blue line and nothing else.
	 * Detecting that case and showing it as an actual "open changelog" link
	 * is clearer than pretending it's prose.
	 */
	function bareUrl(text: string): string | null {
		const trimmed = text.trim();
		return /^https?:\/\/\S+$/.test(trimmed) ? trimmed : null;
	}
	let {
		source,
		projectId,
		versionId = null,
		versionLabel = '',
		defaultTab = 'description',
		onClose
	}: {
		source: string;
		projectId: string;
		versionId?: string | null;
		versionLabel?: string;
		defaultTab?: 'description' | 'changelog';
		onClose: () => void;
	} = $props();

	type Details = {
		name: string;
		author: string | null;
		projectUrl: string | null;
		summary: string | null;
		description: string | null;
		changelog: string | null;
	};

	let details = $state<Details | null>(null);
	let loading = $state(true);
	let error = $state('');
	// svelte-ignore state_referenced_locally
	let tab = $state<'description' | 'changelog'>(defaultTab);
	// The parent reuses this dialog instance rather than remounting it when
	// it's already open and the user clicks the other "Description" /
	// "Changelog" pill - that only changes the defaultTab prop, so without
	// this the dialog would silently keep showing whichever tab it first
	// opened on.
	$effect(() => {
		tab = defaultTab;
	});

	$effect(() => {
		const params = new URLSearchParams({ source, id: projectId });
		if (versionId) params.set('versionId', versionId);

		let cancelled = false;
		loading = true;
		error = '';

		fetch(`/api/mods/details?${params}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load details.'))))
			.then((body) => {
				if (!cancelled) details = body;
			})
			.catch((err) => {
				if (!cancelled) error = err instanceof Error ? err.message : 'Could not load details.';
			})
			.finally(() => {
				if (!cancelled) loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop" role="presentation" onclick={onClose}></div>

<div class="dialog" role="dialog" aria-modal="true" aria-label="Project details">
	<header>
		<div class="title">
			<h2>{details?.name ?? 'Loading'}</h2>
			{#if details?.author}<span class="faint small">by {details.author}</span>{/if}
		</div>
		<button class="close" onclick={onClose} aria-label="Close">×</button>
	</header>

	{#if loading}
		<p class="muted pad">Loading details.</p>
	{:else if error}
		<p class="notice error">{error}</p>
	{:else if details}
		{#if details.summary}
			<p class="summary">{details.summary}</p>
		{/if}

		<div class="tabs" role="tablist">
			<button role="tab" aria-selected={tab === 'description'} onclick={() => (tab = 'description')}>
				Description
			</button>
			<button role="tab" aria-selected={tab === 'changelog'} onclick={() => (tab = 'changelog')}>
				Changelog{versionLabel ? ` (${versionLabel})` : ''}
			</button>
		</div>

		<div class="body markdown">
			{#if tab === 'description'}
				{#if details.description}
					{@const link = bareUrl(details.description)}
					{#if link}
						<p><a href={link} target="_blank" rel="noreferrer">Open the full description</a></p>
					{:else}
						{@html renderMarkdown(details.description)}
					{/if}
				{:else}
					<p class="muted">No description was provided.</p>
				{/if}
			{:else if details.changelog}
				{@const link = bareUrl(details.changelog)}
				{#if link}
					<p><a href={link} target="_blank" rel="noreferrer">Open the changelog</a></p>
				{:else}
					{@html renderMarkdown(details.changelog)}
				{/if}
			{:else}
				<p class="muted">
					{versionId
						? 'No changelog was published for this version.'
						: 'Pick a version to see its changelog.'}
				</p>
			{/if}
		</div>

		{#if details.projectUrl}
			<footer>
				<a class="button button-quiet" href={details.projectUrl} target="_blank" rel="noreferrer">
					Open the project page
				</a>
			</footer>
		{/if}
	{/if}
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgb(0 0 0 / 0.55);
		z-index: 70;
	}

	.dialog {
		position: fixed;
		z-index: 71;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		/* A percentage of the viewport rather than a fixed cap, so it actually
		   uses the space available on a wide screen instead of sitting at a
		   fraction of it - clamped between a floor that stays readable on a
		   small window and a ceiling so text lines don't get absurd on an
		   ultrawide or 4K display. */
		width: clamp(34rem, 50vw, 80rem);
		max-width: calc(100vw - var(--space-5));
		max-height: min(88vh, 60rem);
		display: flex;
		flex-direction: column;
		background: var(--panel);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
		box-shadow: 0 16px 48px rgb(0 0 0 / 0.45);
	}

	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-4);
		border-bottom: 1px solid var(--line);
	}

	.title {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		flex-wrap: wrap;
		min-width: 0;
	}

	h2 {
		margin: 0;
		font-size: 1.05rem;
	}

	.close {
		background: none;
		border: 0;
		color: var(--text-faint);
		font-size: 1.3rem;
		line-height: 1;
		padding: 0 0.25rem;
	}

	.close:hover {
		color: var(--text);
	}

	.summary {
		margin: 0;
		padding: var(--space-3) var(--space-4) 0;
		color: var(--text-muted);
		font-size: 0.9rem;
		max-width: none;
	}

	.tabs {
		display: flex;
		gap: var(--space-1);
		padding: var(--space-3) var(--space-4) 0;
		border-bottom: 1px solid var(--line);
	}

	.tabs button {
		background: none;
		border: 0;
		border-bottom: 2px solid transparent;
		border-radius: 0;
		color: var(--text-muted);
	}

	.tabs button[aria-selected='true'] {
		color: var(--text);
		border-bottom-color: var(--accent);
	}

	.body {
		overflow-y: auto;
		padding: var(--space-4);
		flex: 1 1 auto;
	}

	.body.markdown :global(p) {
		margin: 0 0 var(--space-3);
		max-width: none;
		font-size: 0.85rem;
		color: var(--text-muted);
		line-height: 1.6;
	}

	.body.markdown :global(h1),
	.body.markdown :global(h2),
	.body.markdown :global(h3) {
		font-size: 0.95rem;
		margin: var(--space-4) 0 var(--space-2);
		color: var(--text);
	}

	.body.markdown :global(h1:first-child),
	.body.markdown :global(h2:first-child),
	.body.markdown :global(h3:first-child) {
		margin-top: 0;
	}

	.body.markdown :global(ul),
	.body.markdown :global(ol) {
		margin: 0 0 var(--space-3);
		padding-left: 1.4rem;
		font-size: 0.85rem;
		color: var(--text-muted);
		line-height: 1.6;
	}

	.body.markdown :global(code) {
		font-family: var(--font-mono);
		font-size: 0.8em;
		background: var(--bg-sunken);
		padding: 0.1em 0.35em;
		border-radius: 3px;
	}

	.body.markdown :global(pre) {
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-3);
		overflow-x: auto;
	}

	.body.markdown :global(pre code) {
		background: none;
		padding: 0;
	}

	.body.markdown :global(a) {
		color: var(--accent-hover);
	}

	.body.markdown :global(img) {
		max-width: 100%;
		/* Some sources embed raw <img> tags with explicit width/height HTML
		   attributes, which stop matching once max-width above shrinks the
		   rendered width - height:auto keeps the image scaling proportionally
		   instead of stretching to the original, now-wrong pixel height. */
		height: auto;
		border-radius: var(--radius);
	}

	.body.markdown :global(blockquote) {
		margin: 0 0 var(--space-3);
		padding-left: var(--space-3);
		border-left: 2px solid var(--line-strong);
		color: var(--text-faint);
	}

	.pad {
		padding: var(--space-4);
	}

	footer {
		padding: var(--space-3) var(--space-4);
		border-top: 1px solid var(--line);
	}
</style>
