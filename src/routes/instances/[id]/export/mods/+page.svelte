<script lang="ts">
	import SegmentedChoice from '#lib/components/SegmentedChoice.svelte';
	import { can } from '#lib/shared/access.js';
	import { copyText } from '#lib/shared/clipboard.js';
	import { fitToViewport } from '#lib/shared/fitToViewport.js';
	import { formatModList, MODLIST_FIELDS, MODLIST_FORMATS, type ModListField, type ModListFormat } from '#lib/shared/modlist.js';
	import { streamed } from '#lib/shared/streamed.svelte.js';

	let { data } = $props();

	const files = $derived(can(data.access, data.instance.id, 'files'));
	const base = $derived(`/instances/${encodeURIComponent(data.instance.id)}/export`);

	const loaded = streamed(() => data.mods, () => data.instance.id);
	const mods = $derived(loaded.ready ? (loaded.value ?? []) : null);

	let format = $state<ModListFormat>('markdown');
	let fields = $state<ModListField[]>(['version', 'authors', 'url']);
	let withDisabled = $state(false);
	let copied = $state<boolean | null>(null);

	const listed = $derived(mods?.filter((m) => withDisabled || m.enabled) ?? []);
	const text = $derived(formatModList(listed, format, fields));
	const disabledCount = $derived(mods?.filter((m) => !m.enabled).length ?? 0);

	function toggleField(id: ModListField, on: boolean) {
		fields = on ? MODLIST_FIELDS.map((f) => f.id).filter((f) => f === id || fields.includes(f)) : fields.filter((f) => f !== id);
	}

	async function copy() {
		copied = await copyText(text);
		setTimeout(() => (copied = null), 2000);
	}

	function download() {
		const kind = MODLIST_FORMATS.find((f) => f.id === format)!;
		const link = document.createElement('a');
		link.href = URL.createObjectURL(new Blob([text], { type: `${kind.type};charset=utf-8` }));
		link.download = `${data.instance.name.replace(/[\\/:*?"<>|]+/g, '_')} mods.${kind.ext}`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(link.href), 1000);
	}
</script>

<svelte:head><title>Mod list - {data.instance.name} - MineShell</title></svelte:head>

<div class="subhead">
	<nav class="subtabs" aria-label="Export">
		{#if files}<a href={base}>Client pack</a>{/if}
		<a href="{base}/mods" aria-current="page">Mod list</a>
		{#if files}<a href="{base}/server">Move to another MineShell</a>{/if}
	</nav>
</div>

<header class="section-head">
	<div>
		<h2>Export the mod list</h2>
		<p>The server's mods as text, for a pack page, a forum post or a bug report.</p>
	</div>
</header>

<section class="panel block">
	<div class="options">
		<div class="field">
			<span class="label" id="modlist-format">Format</span>
			<SegmentedChoice options={MODLIST_FORMATS.map((f) => ({ value: f.id, label: f.label }))} bind:value={format} labelledby="modlist-format" />
		</div>
		<div class="field">
			<span class="label">With each name</span>
			<div class="checks">
				{#each MODLIST_FIELDS as f (f.id)}
					<label class="check">
						<input type="checkbox" checked={fields.includes(f.id)} onchange={(e) => toggleField(f.id, e.currentTarget.checked)} />
						{f.label}
					</label>
				{/each}
			</div>
		</div>
		{#if disabledCount}
			<label class="check">
				<input type="checkbox" bind:checked={withDisabled} />
				Disabled mods too ({disabledCount}, client-only ones among them)
			</label>
		{/if}
	</div>
</section>

{#if mods === null}
	<p class="muted">Looking through the mods.</p>
{:else if mods.length === 0}
	<p class="faint">This server has no mods.</p>
{:else}
	<div class="actions">
		<span class="small muted">{listed.length} {listed.length === 1 ? 'mod' : 'mods'}</span>
		<button type="button" class="button-primary" onclick={copy}>{copied === true ? 'Copied' : 'Copy'}</button>
		<button type="button" onclick={download}>Download</button>
		{#if copied === false}<span class="small copy-failed">The browser would not copy; select the text below instead.</span>{/if}
	</div>
	<pre class="output panel" use:fitToViewport>{text}</pre>
{/if}

<style>
	.block {
		padding: var(--space-4);
		margin-bottom: var(--space-4);
	}

	.options {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.options .field {
		margin: 0;
	}

	.checks {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
	}

	.check {
		align-items: center;
		margin: 0;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}

	.copy-failed {
		color: var(--error);
	}

	.output {
		padding: var(--space-3) var(--space-4);
		overflow: auto;
		white-space: pre;
	}
</style>
