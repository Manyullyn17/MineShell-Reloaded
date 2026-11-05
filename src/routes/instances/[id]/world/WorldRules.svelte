<script lang="ts">
	import { postAction, actionMessage } from '#lib/shared/forms.js';
	import { followKey } from '#lib/shared/follow.svelte.js';
	import Flash from '#lib/components/Flash.svelte';

	/**
	 * World > Game rules: one world's rules, spawn and border (worldrules.ts). Read through
	 * the endpoint when a world is picked; Save posts only what changed, which the server
	 * applies over RCON to the running server's active world, else to the world's files.
	 */
	let {
		instanceId,
		worlds
	}: {
		instanceId: string;
		worlds: { folder: string; name: string; active: boolean }[];
	} = $props();

	type Value = boolean | number | string;
	type Rules = {
		world: string;
		live: boolean;
		rules: { key: string; name: string; description: string | null; value: Value; vanilla: boolean }[];
		spawn: { x: number; y: number; z: number } | null;
		border: { x: number; z: number; size: number } | null;
		borderSupported: boolean;
		/** The server's max-world-size, for every world; null before 1.8. */
		maxWorldSize: number | null;
	};

	// svelte-ignore state_referenced_locally
	let world = $state(worlds.find((w) => w.active)?.folder ?? worlds[0]?.folder ?? '');
	let loaded = $state<Rules | null>(null);
	let loadError = $state('');
	let filter = $state('');
	let saving = $state(false);
	let message = $state<{ ok: boolean; message: string } | null>(null);
	// What the form shows: the rules by key, spawn and border as text so a field can be half typed.
	let values = $state<Record<string, Value>>({});
	let spawn = $state({ x: '', y: '', z: '' });
	let border = $state({ on: false, x: '', z: '', size: '' });
	let limit = $state('');

	async function load(folder: string) {
		loadError = '';
		try {
			const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/world-rules?world=${encodeURIComponent(folder)}`);
			const body = await res.json();
			if (!res.ok) throw new Error(body.message ?? 'Could not read the world.');
			loaded = body;
			values = Object.fromEntries(body.rules.map((r: Rules['rules'][number]) => [r.key, r.value]));
			spawn = body.spawn ? { x: String(body.spawn.x), y: String(body.spawn.y), z: String(body.spawn.z) } : { x: '', y: '', z: '' };
			border = body.border
				? { on: true, x: String(body.border.x), z: String(body.border.z), size: String(body.border.size) }
				: { on: false, x: '0', z: '0', size: '' };
			limit = body.maxWorldSize === null ? '' : String(body.maxWorldSize);
		} catch (err) {
			loaded = null;
			loadError = err instanceof Error ? err.message : 'Could not read the world.';
		}
	}

	// Only for another world: a running server's page reloads every few seconds, and reading
	// the world again each time threw away what was being typed here.
	followKey(
		() => `${instanceId}/${world}`,
		() => {
			void load(world);
			return () => {};
		}
	);

	const shown = $derived(
		(loaded?.rules ?? []).filter((r) => !filter.trim() || `${r.name} ${r.key} ${r.description ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()))
	);

	/** What differs from what was read: only that is posted. */
	const changes = $derived.by(() => {
		if (!loaded) return null;
		const rules = Object.fromEntries(loaded.rules.filter((r) => values[r.key] !== r.value).map((r) => [r.key, values[r.key]]));
		const out: {
			rules?: Record<string, Value>;
			spawn?: { x: number; y: number; z: number };
			border?: { x: number; z: number; size: number } | null;
			maxWorldSize?: number;
		} = {};
		if (Object.keys(rules).length) out.rules = rules;
		const s = { x: Number(spawn.x), y: Number(spawn.y), z: Number(spawn.z) };
		if (loaded.spawn && (s.x !== loaded.spawn.x || s.y !== loaded.spawn.y || s.z !== loaded.spawn.z)) out.spawn = s;
		const b = border.on ? { x: Number(border.x), z: Number(border.z), size: Number(border.size) } : null;
		if (loaded.borderSupported && JSON.stringify(b) !== JSON.stringify(loaded.border)) out.border = b;
		if (loaded.maxWorldSize !== null && Number(limit) !== loaded.maxWorldSize) out.maxWorldSize = Number(limit);
		return out;
	});
	const changed = $derived(!!changes && Object.keys(changes).length > 0);
	/** Where the border reaches past the limit, the world stops at the limit instead. */
	const borderPastLimit = $derived.by(() => {
		const max = Number(limit);
		if (!border.on || !(max > 0)) return false;
		const half = Number(border.size) / 2;
		return Math.abs(Number(border.x)) + half > max || Math.abs(Number(border.z)) + half > max;
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!changes || !changed) return;
		saving = true;
		const body = new FormData();
		body.set('world', world);
		body.set('changes', JSON.stringify(changes));
		const result = await postAction('?/worldRules', body);
		message = { ok: result.type === 'success', message: actionMessage(result, 'Saved.') };
		saving = false;
		if (result.type === 'success') await load(world);
	}
</script>

<section class="view">
	<div class="section-head">
		<div>
			<h2>Game rules</h2>
			<p>
				A world's own settings: the game rules (mods' too), where new players spawn and the world border. On a running
				server the active world changes at once; any other world, or the server stopped, has them written to the world's
				files, read at its next start. The world size limit is the server's, for all its worlds.
			</p>
		</div>
		{#if worlds.length > 1}
			<select bind:value={world} aria-label="World">
				{#each worlds as w (w.folder)}<option value={w.folder}>{w.name}{w.active ? ' (active)' : ''}</option>{/each}
			</select>
		{/if}
	</div>

	{#if message}<Flash form={message} />{/if}
	{#if loadError}
		<p class="notice warning">{loadError}</p>
	{:else if loaded}
		<form onsubmit={save}>
			<p class="small muted">
				{loaded.live ? 'The server is running this world: changes apply now, over RCON.' : 'Changes are written to the world and apply when it next loads.'}
			</p>

			<div class="place">
				<fieldset>
					<legend>World spawn</legend>
					{#if loaded.spawn}
						<div class="xyz">
							<label>x <input autocomplete="off" bind:value={spawn.x} inputmode="numeric" /></label>
							<label>y <input autocomplete="off" bind:value={spawn.y} inputmode="numeric" /></label>
							<label>z <input autocomplete="off" bind:value={spawn.z} inputmode="numeric" /></label>
						</div>
						<p class="hint">Where new players and ones without a bed appear (spread around it by the spawn radius rule).</p>
					{:else}
						<p class="hint">Not in this world's level.dat yet.</p>
					{/if}
				</fieldset>
				{#if loaded.borderSupported}
					<fieldset>
						<legend>World border</legend>
						<label class="check"><input type="checkbox" class="switch" role="switch" bind:checked={border.on} /> A border</label>
						{#if border.on}
							<div class="xyz">
								<label>Centre x <input autocomplete="off" bind:value={border.x} inputmode="numeric" /></label>
								<label>Centre z <input autocomplete="off" bind:value={border.z} inputmode="numeric" /></label>
								<label>Across <input autocomplete="off" bind:value={border.size} inputmode="numeric" placeholder="blocks" /></label>
							</div>
						{/if}
						<p class="hint">The overworld's; the Nether follows it at an eighth of the size.</p>
						{#if borderPastLimit}
							<p class="hint warn">Past {Number(limit).toLocaleString('en')} blocks from 0,0 the world size limit stops it first.</p>
						{/if}
					</fieldset>
				{/if}
				{#if loaded.maxWorldSize !== null}
					<fieldset>
						<legend>World size limit <span class="tag">restart</span></legend>
						<label>Blocks from 0,0 <input autocomplete="off" bind:value={limit} inputmode="numeric" /></label>
						<p class="hint">
							No block further out than this in x or z, in every world and dimension of the server (server.properties
							<code>max-world-size</code>). {Number(limit) === 29999984 ? 'This is the most, the normal edge of the world.' : 'At most 29,999,984, the normal edge of the world.'}
						</p>
					</fieldset>
				{/if}
			</div>

			<div class="rules-head">
				<h3>Rules <span class="faint small">{loaded.rules.length}</span></h3>
				<input type="search" autocomplete="off" placeholder="Filter rules" bind:value={filter} aria-label="Filter rules" />
			</div>
			{#if !loaded.rules.length}
				<p class="hint">This world keeps no game rules yet: start the server once.</p>
			{/if}
			<div class="table-box">
				<table>
					<tbody>
						{#each shown as rule (rule.key)}
							<tr class:changed={values[rule.key] !== rule.value}>
								<td>
									<label for="rule-{rule.key}"><strong>{rule.name}</strong></label>
									{#if !rule.vanilla}<span class="tag">mod</span>{/if}
									<div class="faint small mono key">{rule.key}</div>
									{#if rule.description}<div class="muted small">{rule.description}</div>{/if}
								</td>
								<td class="value">
									{#if typeof rule.value === 'boolean'}
										<input
											id="rule-{rule.key}"
											type="checkbox"
											class="switch"
											role="switch"
											checked={values[rule.key] === true}
											onchange={(e) => (values[rule.key] = e.currentTarget.checked)}
										/>
									{:else if typeof rule.value === 'number'}
										<input
											id="rule-{rule.key}"
											autocomplete="off"
											inputmode="numeric"
											value={String(values[rule.key])}
											oninput={(e) => {
												const n = Number(e.currentTarget.value);
												values[rule.key] = e.currentTarget.value.trim() !== '' && Number.isFinite(n) ? n : e.currentTarget.value;
											}}
										/>
									{:else}
										<input id="rule-{rule.key}" autocomplete="off" value={String(values[rule.key])} oninput={(e) => (values[rule.key] = e.currentTarget.value)} />
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<div class="save">
				<button class="button-primary" type="submit" disabled={!changed || saving}>{saving ? 'Saving' : 'Save'}</button>
				{#if changed}<button class="button-quiet" type="button" onclick={() => load(world)}>Undo changes</button>{/if}
			</div>
		</form>
	{:else}
		<p class="faint small">Reading the world.</p>
	{/if}
</section>

<style>
	.place {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
		gap: var(--space-3);
		margin: var(--space-3) 0 var(--space-4);
	}

	fieldset {
		margin: 0;
		padding: var(--space-3);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		min-width: 0;
	}

	legend {
		padding: 0 var(--space-1);
		font-weight: 600;
	}

	.xyz {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-2);
		margin: var(--space-2) 0;
	}

	.hint.warn {
		color: var(--warning);
	}

	.xyz label {
		margin: 0;
		font-size: 0.85rem;
	}

	.rules-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-bottom: var(--space-2);
	}

	.rules-head h3 {
		margin: 0;
	}

	.rules-head input {
		width: auto;
		min-width: 0;
		flex: 0 1 16rem;
	}

	td .key {
		overflow-wrap: anywhere;
	}

	td.value {
		width: 9rem;
		text-align: right;
		vertical-align: middle;
	}

	td.value input:not([type='checkbox']) {
		width: 100%;
	}

	tr.changed > td {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}

	.save {
		position: sticky;
		bottom: 0;
		display: flex;
		gap: var(--space-2);
		padding: var(--space-3) 0;
		background: var(--bg);
	}
</style>
