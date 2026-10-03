<script lang="ts">
	import { deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import Flash from '$lib/components/Flash.svelte';
	import NbtNode from '$lib/components/NbtNode.svelte';
	import { formatDateTime } from '$lib/shared/format';

	let { data } = $props();

	type Item = (typeof data.view.items)[number];
	type Section = Item['section'];

	let result = $state<{ ok: boolean; message: string } | null>(null);
	let busy = $state(false);
	const locked = $derived(!!data.locked);
	const base = $derived(`/instances/${encodeURIComponent(data.instance.id)}/players`);

	/** Post one action and reload the page's data; true when it was saved. */
	async function post(action: string, fields: Record<string, string>): Promise<boolean> {
		busy = true;
		try {
			const body = new FormData();
			body.set('version', data.version);
			for (const [k, v] of Object.entries(fields)) body.set(k, v);
			const res = await fetch(`?/${action}`, { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
			const outcome = deserialize(await res.text());
			if (outcome.type === 'success' || outcome.type === 'failure') {
				const d = outcome.data as { ok?: boolean; message?: string } | undefined;
				result = { ok: outcome.type === 'success', message: d?.message ?? '' };
			} else {
				result = { ok: false, message: 'Could not save.' };
			}
			await invalidateAll();
			return outcome.type === 'success';
		} catch {
			result = { ok: false, message: 'Could not reach MineShell.' };
			return false;
		} finally {
			busy = false;
		}
	}

	const save = (edits: Record<string, unknown>[]) => post('edit', { edits: JSON.stringify(edits) });

	// ---- stats
	const GAME_MODES = ['Survival', 'Creative', 'Adventure', 'Spectator'];
	type StatField = { key: string; label: string; path: (string | number)[]; value: number | null; step: string };
	const statFields = $derived<StatField[]>(
		[
			{ key: 'health', label: 'Health', path: ['Health'], value: data.view.stats.health, step: '0.5' },
			{ key: 'food', label: 'Food', path: ['foodLevel'], value: data.view.stats.food, step: '1' },
			{ key: 'saturation', label: 'Saturation', path: ['foodSaturationLevel'], value: data.view.stats.saturation, step: 'any' },
			{ key: 'xp', label: 'XP level', path: ['XpLevel'], value: data.view.stats.xpLevel, step: '1' },
			...(data.view.stats.pos ?? []).map((v, i) => ({ key: `pos${i}`, label: 'XYZ'[i], path: ['Pos', i], value: v, step: 'any' }))
		].filter((f) => f.value !== null)
	);
	// Number inputs bind numbers; edits carry text.
	let stats = $state<Record<string, string | number>>({});
	let gameMode = $state('');
	$effect(() => {
		stats = Object.fromEntries(statFields.map((f) => [f.key, String(Number(f.value!.toFixed(4)))]));
		gameMode = data.view.stats.gameMode === null ? '' : String(data.view.stats.gameMode);
	});

	async function saveStats(event: SubmitEvent) {
		event.preventDefault();
		const edits: Record<string, unknown>[] = statFields
			.filter((f) => Number(stats[f.key]) !== Number(f.value!.toFixed(4)))
			.map((f) => ({ op: 'set', path: f.path, value: String(stats[f.key]) }));
		if (data.view.stats.gameMode !== null && gameMode !== String(data.view.stats.gameMode)) {
			edits.push({ op: 'set', path: ['playerGameType'], value: gameMode });
		}
		if (edits.length === 0) {
			result = { ok: true, message: 'Nothing changed.' };
			return;
		}
		await save(edits);
	}

	// ---- inventory
	let tab = $state<'inventory' | 'ender'>('inventory');
	let selected = $state<{ section: Section; slot: number } | null>(null);
	let itemId = $state('');
	let itemCount = $state('1');
	let itemDamage = $state('0');

	const itemAt = (section: Section, slot: number) => data.view.items.find((i) => i.section === section && i.slot === slot) ?? null;
	const selectedItem = $derived(selected ? itemAt(selected.section, selected.slot) : null);
	const otherItems = $derived(data.view.items.filter((i) => i.section === 'other'));

	function pick(section: Section, slot: number) {
		selected = { section, slot };
		const item = itemAt(section, slot);
		itemId = item?.id ?? '';
		itemCount = String(item?.count ?? 1);
		itemDamage = String(item?.damage ?? 0);
	}

	async function saveItem(event: SubmitEvent) {
		event.preventDefault();
		if (!selected) return;
		await save([
			{
				op: 'item',
				section: selected.section,
				slot: selected.slot,
				id: itemId,
				count: Number(itemCount),
				...(data.view.format === 'legacy' ? { damage: Number(itemDamage) } : {})
			}
		]);
	}

	async function removeItem() {
		if (selected && (await save([{ op: 'removeItem', section: selected.section, slot: selected.slot }]))) selected = null;
	}

	const short = (id: string) => id.replace(/^minecraft:/, '').replace(/_/g, ' ');
	const SLOT_LABELS: Record<number, string> = { 103: 'Head', 102: 'Chest', 101: 'Legs', 100: 'Feet', [-106]: 'Offhand' };
	const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
	const FORMAT_LABEL = { legacy: 'Minecraft 1.12 and older', flat: 'Minecraft 1.13 to 1.20.4', components: 'Minecraft 1.20.5 and newer' };
</script>

<svelte:head><title>{data.name ?? data.uuid} - Players - MineShell</title></svelte:head>

{#snippet cell(section: Section, slot: number, label: string | null = null)}
	{@const item = itemAt(section, slot)}
	<button
		type="button"
		class="slot"
		class:filled={!!item}
		aria-pressed={selected?.section === section && selected.slot === slot}
		title={item ? `${item.id}${item.name ? ` "${item.name}"` : ''}${item.count > 1 ? ` x${item.count}` : ''}` : `Empty${label ? ` (${label})` : ''}`}
		onclick={() => pick(section, slot)}
	>
		{#if item}
			<span class="item-name">{item.name ?? short(item.id)}</span>
			{#if item.count > 1}<span class="count">{item.count}</span>{/if}
			{#if item.hasData}<span class="data-dot" aria-label="has extra data"></span>{/if}
		{:else if label}
			<span class="slot-label">{label}</span>
		{/if}
	</button>
{/snippet}

<p class="back"><a href={base}>← Players</a></p>

<header class="head">
	<h2>{data.name ?? 'Unknown name'}</h2>
	<p class="mono small muted">{data.uuid}</p>
	<p class="small faint">
		{FORMAT_LABEL[data.view.format]} data{data.view.dataVersion !== null ? ` (DataVersion ${data.view.dataVersion})` : ''}
	</p>
</header>

{#if data.locked}
	<div class="notice warning"><p>{data.locked}</p></div>
{/if}
<Flash form={result} />

<section class="panel">
	<h2>Stats</h2>
	<form class="stats" onsubmit={saveStats}>
		{#each statFields as f (f.key)}
			<div class="field">
				<label for="stat-{f.key}">{f.label}</label>
				<input id="stat-{f.key}" type="number" step={f.step} bind:value={stats[f.key]} disabled={locked} />
			</div>
		{/each}
		{#if data.view.stats.gameMode !== null}
			<div class="field">
				<label for="stat-mode">Game mode</label>
				<select id="stat-mode" bind:value={gameMode} disabled={locked}>
					{#each GAME_MODES as mode, i (mode)}<option value={String(i)}>{mode}</option>{/each}
				</select>
			</div>
		{/if}
		{#if data.view.stats.dimension !== null}
			<div class="field">
				<span class="label-text">Dimension</span>
				<span class="mono small dimension">{data.view.stats.dimension}</span>
			</div>
		{/if}
		<button class="button-primary" type="submit" disabled={locked || busy}>Save stats</button>
	</form>
</section>

<section class="panel">
	<div class="inv-head">
		<div class="switcher" role="tablist">
			<button role="tab" aria-selected={tab === 'inventory'} onclick={() => ((tab = 'inventory'), (selected = null))}>Inventory</button>
			<button role="tab" aria-selected={tab === 'ender'} onclick={() => ((tab = 'ender'), (selected = null))}>Ender chest</button>
		</div>
		<p class="small faint">Pick a slot to change, add or remove its item.</p>
	</div>

	<div class="inv-layout">
		<div class="grids">
			{#if tab === 'inventory'}
				<div class="equip">
					{#each [103, 102, 101, 100] as slot (slot)}{@render cell('armor', slot, SLOT_LABELS[slot])}{/each}
					<span class="gap"></span>
					{@render cell('offhand', -106, 'Offhand')}
				</div>
				<div class="grid">{#each range(9, 35) as slot (slot)}{@render cell('main', slot)}{/each}</div>
				<div class="grid hotbar">{#each range(0, 8) as slot (slot)}{@render cell('main', slot)}{/each}</div>
				{#if otherItems.length}
					<p class="small muted">
						Also in other slots (mods): {otherItems.map((i) => `${short(i.id)} x${i.count} (slot ${i.slot})`).join(', ')}. Edit
						those in the data below.
					</p>
				{/if}
			{:else}
				<div class="grid">{#each range(0, 26) as slot (slot)}{@render cell('ender', slot)}{/each}</div>
			{/if}
		</div>

		{#if selected}
			<form class="item-editor" onsubmit={saveItem}>
				<h3>{selected.section === 'ender' ? 'Ender chest' : (SLOT_LABELS[selected.slot] ?? (selected.slot < 9 ? 'Hotbar' : 'Inventory'))} slot {selected.slot}</h3>
				<div class="field">
					<label for="item-id">Item id</label>
					<input id="item-id" class="mono" bind:value={itemId} placeholder="minecraft:diamond" required disabled={locked} />
				</div>
				<div class="field">
					<label for="item-count">Count</label>
					<input id="item-count" type="number" min="1" max={data.view.format === 'components' ? 99 : 127} bind:value={itemCount} disabled={locked} />
				</div>
				{#if data.view.format === 'legacy'}
					<div class="field">
						<label for="item-damage">Damage / metadata</label>
						<input id="item-damage" type="number" bind:value={itemDamage} disabled={locked} />
					</div>
				{/if}
				{#if selectedItem?.hasData}
					<p class="hint">
						This item has more data (enchantments, a name, mod data). It is kept when the id or count changes; edit it under
						<code>{selectedItem.path.join(' › ')}</code> below.
					</p>
				{/if}
				<div class="buttons">
					<button class="button-primary" type="submit" disabled={locked || busy}>{selectedItem ? 'Save item' : 'Add item'}</button>
					{#if selectedItem}
						<button class="button-danger" type="button" disabled={locked || busy} onclick={removeItem}>Remove</button>
					{/if}
					<button type="button" onclick={() => (selected = null)}>Close</button>
				</div>
			</form>
		{/if}
	</div>
</section>

<section class="panel">
	<h2>All data</h2>
	<p class="small muted">
		Everything in the player's file, including what mods store there. Hover an entry to edit, add or remove; each
		change is saved on its own.
	</p>
	<ul class="tree">
		{#each data.view.tree.type === 'compound' ? data.view.tree.value : [] as [key, value], i (`${key}:${i}`)}
			<NbtNode name={key} tag={value} path={[key]} {locked} onEdit={(edit) => save([edit])} />
		{/each}
	</ul>
</section>

<section class="panel">
	<h2>Backups</h2>
	<p class="small muted">
		MineShell keeps the file as it was before each editing session (the newest 10).
	</p>
	{#if data.backups.length === 0}
		<p class="small muted">None yet: the first change makes one.</p>
	{:else}
		<ul class="backups">
			{#each data.backups as backup (backup.name)}
				<li>
					<span>{formatDateTime(backup.at)}</span>
					<button type="button" disabled={locked || busy} onclick={() => post('restore', { backup: backup.name })}>Restore</button>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.back {
		margin: 0 0 var(--space-3);
	}

	.head {
		margin-bottom: var(--space-4);
	}

	.head h2,
	.head p {
		margin: 0;
	}

	.stats {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-3);
	}

	.stats .field {
		margin: 0;
		width: 8rem;
	}

	.label-text {
		display: block;
		font-size: 0.85rem;
		color: var(--text-muted);
		margin-bottom: var(--space-2);
	}

	.dimension {
		display: block;
		padding: 0.42rem 0;
	}

	.inv-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}

	.inv-head p {
		margin: 0;
	}

	.switcher {
		display: flex;
		gap: var(--space-1);
	}

	.switcher button[aria-selected='true'] {
		background: var(--bg-sunken);
		border-color: var(--accent);
	}

	.inv-layout {
		display: flex;
		gap: var(--space-5);
		align-items: flex-start;
		flex-wrap: wrap;
	}

	.grids {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.grid,
	.equip {
		display: grid;
		grid-template-columns: repeat(9, 3.75rem);
		gap: 3px;
	}

	.equip .gap {
		grid-column: span 1;
	}

	.hotbar {
		margin-top: var(--space-1);
	}

	.slot {
		position: relative;
		width: 3.75rem;
		height: 3.75rem;
		padding: 2px;
		border-radius: 4px;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		font-weight: normal;
		white-space: normal;
		overflow: hidden;
	}

	.slot.filled {
		background: var(--panel-raised);
		border-color: var(--line-strong);
	}

	.slot[aria-pressed='true'] {
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
	}

	.item-name {
		font-size: 0.62rem;
		line-height: 1.1;
		text-align: center;
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.slot-label {
		font-size: 0.6rem;
		color: var(--text-faint);
	}

	.count {
		position: absolute;
		right: 3px;
		bottom: 1px;
		font-size: 0.68rem;
		font-weight: 600;
		font-family: var(--font-mono);
	}

	.data-dot {
		position: absolute;
		top: 3px;
		right: 3px;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--accent);
	}

	.item-editor {
		flex: 1 1 16rem;
		max-width: 24rem;
		border-left: 1px solid var(--line);
		padding-left: var(--space-4);
	}

	.item-editor h3 {
		margin: 0 0 var(--space-3);
		font-size: 0.95rem;
	}

	.buttons {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.tree {
		margin: 0;
		padding: 0;
	}

	.backups {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-1);
		max-width: 28rem;
	}

	.backups li {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.backups button {
		font-size: 0.8rem;
		padding: 0.2rem 0.5rem;
	}
</style>
