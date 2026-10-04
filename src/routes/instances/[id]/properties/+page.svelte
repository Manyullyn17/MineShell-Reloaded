<script lang="ts">
	import { enhance } from '$app/forms';
	import Flash from '#lib/components/Flash.svelte';
	import PropertyInput from '#lib/components/PropertyInput.svelte';

	let { data, form } = $props();

	let showRaw = $state(false);

	// ---- server icon: scaled to the 64x64 PNG Minecraft wants, here in the browser
	const iconUrl = $derived(`/api/instances/${encodeURIComponent(data.instance.id)}/icon`);
	// svelte-ignore state_referenced_locally
	let hasIcon = $state(data.hasIcon);
	let iconVersion = $state(0);
	let iconError = $state('');

	/** Centre-crop to a square and scale to 64x64, as a PNG. */
	async function toIcon(file: File): Promise<Blob> {
		const image = await createImageBitmap(file);
		const side = Math.min(image.width, image.height);
		const canvas = document.createElement('canvas');
		canvas.width = 64;
		canvas.height = 64;
		const ctx = canvas.getContext('2d')!;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 64, 64);
		return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not convert the image.'))), 'image/png'));
	}

	async function pickIcon(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		iconError = '';
		try {
			const res = await fetch(iconUrl, { method: 'PUT', body: await toIcon(file) });
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Upload failed.');
			hasIcon = true;
			iconVersion++;
		} catch (err) {
			iconError = err instanceof Error ? err.message : 'Upload failed.';
		}
	}

	async function removeIcon() {
		iconError = '';
		const res = await fetch(iconUrl, { method: 'DELETE' });
		if (res.ok) hasIcon = false;
		else iconError = 'Could not remove the icon.';
	}

	// Plain one-way value={...}/checked={...} bindings on <select> and
	// checkboxes did not pick up a fresh save until switching tabs and back -
	// confirmed here and on the instance settings page, both built the same
	// way. bind:value/bind:checked against local state that re-syncs
	// whenever `data` changes (the pattern the JVM preset picker on settings
	// already used, and which never showed the bug) fixes it.
	// The $effect below keeps this current - this initial read is deliberate.
	// svelte-ignore state_referenced_locally
	let rawValue = $state(data.raw);
	let fieldValues = $state<Record<string, string>>({});
	let fieldChecks = $state<Record<string, boolean>>({});
	$effect(() => {
		rawValue = data.raw;
		const values: Record<string, string> = {};
		const checks: Record<string, boolean> = {};
		for (const field of data.schema) {
			if (field.type === 'boolean') checks[field.key] = data.values[field.key] === 'true';
			else values[field.key] = data.values[field.key] ?? '';
		}
		for (const extra of data.extras) values[`extra:${extra.key}`] = extra.value;
		fieldValues = values;
		fieldChecks = checks;
	});

	// use:enhance's default success handling includes form.reset(), which
	// reverts every field in the form to its hydration-time default - for a
	// form editing existing values (as opposed to one that's adding a new
	// item) that's a brief, visible flash back to blank/default before the
	// effect above re-syncs everything to the actual saved values a moment
	// later. Keeping every other default behaviour, just not that part.
	function keepValues() {
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
		};
	}

	const grouped = $derived(
		data.groups
			.map((group) => ({ group, fields: data.schema.filter((f) => f.group === group) }))
			.filter((g) => g.fields.length > 0)
	);
</script>

<Flash {form} />

{#if data.running}
	<div class="notice info">
		<p>The server is running. Changes are written now but only take effect after a restart.</p>
	</div>
{/if}

<section class="panel icon-panel">
	{#if hasIcon}
		<img src="{iconUrl}?v={iconVersion}" alt="Server icon" width="64" height="64" />
	{:else}
		<div class="icon-placeholder" aria-hidden="true">?</div>
	{/if}
	<div>
		<h2>Server icon</h2>
		<p class="muted small">
			Shown next to the server in players' server lists. Any image works; it is cropped to a square and scaled to
			the 64x64 PNG Minecraft needs. Takes effect on the next start.
		</p>
		<div class="button-row">
			<label class="button">
				{hasIcon ? 'Replace' : 'Choose an image'}
				<input type="file" accept="image/*" class="visually-hidden" onchange={pickIcon} />
			</label>
			{#if hasIcon}<button class="button-quiet" type="button" onclick={removeIcon}>Remove</button>{/if}
		</div>
		{#if iconError}<p class="hint warn-text">{iconError}</p>{/if}
	</div>
</section>

<div class="switcher">
	<button class:active={!showRaw} onclick={() => (showRaw = false)}>Guided</button>
	<button class:active={showRaw} onclick={() => (showRaw = true)}>Raw file</button>
</div>

{#if showRaw}
	<form class="panel" method="POST" action="?/saveRaw" use:enhance={keepValues}>
		<div class="panel-head">
			<div>
				<h2>server.properties</h2>
				<p>Anything you write here is saved as-is. Comments and ordering are not preserved.</p>
			</div>
		</div>
		<textarea name="raw" rows="24" spellcheck="false" class="mono" bind:value={rawValue}></textarea>
		<div class="button-row save-row">
			<button class="button-primary" type="submit">Save file</button>
		</div>
	</form>
{:else}
	<form method="POST" action="?/save" use:enhance={keepValues}>
		{#each grouped as section (section.group)}
			<section class="panel">
				<h2>{section.group}</h2>
				<div class="fields">
					{#each section.fields as field (field.key)}
						<div class="field" class:wide={field.type === 'textarea'}>
							{#if field.type === 'boolean'}
								<PropertyInput {field} bind:checked={fieldChecks[field.key]} />
							{:else}
								<PropertyInput {field} bind:value={fieldValues[field.key]} />
							{/if}
						</div>
					{/each}
				</div>
			</section>
		{/each}

		{#if data.extras.length}
			<section class="panel">
				<div class="panel-head">
					<div>
						<h2>Other keys</h2>
						<p>
							Keys MineShell has no dedicated control for, usually added by a mod or the pack.
							They are kept exactly as written.
						</p>
					</div>
				</div>
				<div class="fields">
					{#each data.extras as extra (extra.key)}
						<div class="field">
							<label for={`extra-${extra.key}`}>{extra.key}</label>
							<input
								id={`extra-${extra.key}`}
								name={`extra:${extra.key}`}
								type="text"
								bind:value={fieldValues[`extra:${extra.key}`]}
							/>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<div class="button-row save-row">
			<button class="button-primary" type="submit">Save changes</button>
		</div>
	</form>
{/if}

<style>
	.icon-panel {
		display: flex;
		gap: var(--space-4);
		align-items: flex-start;
	}

	.icon-panel img,
	.icon-placeholder {
		width: 64px;
		height: 64px;
		flex: none;
		border-radius: var(--radius);
		image-rendering: pixelated;
	}

	.icon-placeholder {
		display: grid;
		place-items: center;
		border: 1px dashed var(--line-strong);
		color: var(--text-muted);
	}

	.icon-panel h2 {
		margin-top: 0;
	}

	.warn-text {
		color: var(--warning);
	}

	.switcher {
		display: inline-flex;
		gap: 0;
		margin-bottom: var(--space-4);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
		overflow: hidden;
	}

	.switcher button {
		border: 0;
		border-radius: 0;
		background: transparent;
		color: var(--text-muted);
	}

	.switcher button.active {
		background: var(--panel-raised);
		color: var(--text);
	}

	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: var(--space-4);
	}

	.fields .field {
		margin-bottom: 0;
	}

	.fields .wide {
		grid-column: 1 / -1;
	}

	textarea.mono {
		font-family: var(--font-mono);
		font-size: 0.8rem;
	}

	.save-row {
		position: sticky;
		bottom: 0;
		padding: var(--space-3) 0;
		background: linear-gradient(to top, var(--bg) 60%, transparent);
	}
</style>
