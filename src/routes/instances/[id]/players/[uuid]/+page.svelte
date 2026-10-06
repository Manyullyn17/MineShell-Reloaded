<script lang="ts">
	import { avatarTone } from '#lib/shared/avatar.js';
	import { deserialize } from '$app/forms';
	import { refreshAll } from '$app/navigation';
	import NbtNode from '#lib/components/NbtNode.svelte';
	import { formatDateTime, formatRelative } from '#lib/shared/format.js';
	import { countMatches, type Path, type TreeTag } from '#lib/shared/nbt.js';
	import { toast } from '#lib/shared/toasts.svelte.js';

	let { data } = $props();

	type Item = (typeof data.view.items)[number];
	type Container = Item['containers'][number];
	type Field = (typeof data.view.fields)[number];
	type CustomField = (typeof data.customFields)[number];
	/** A slot: one of the player's own, or one inside a container (by the container's list). */
	type Loc = { kind: 'slot'; section: Item['section']; slot: number } | { kind: 'container'; list: Path; slot: number };

	/** Results go to a toast: one message for the item panel and the page alike, closable, gone after a few seconds. */
	const report = (ok: boolean, message: string) => message && toast({ tone: ok ? 'ok' : 'error', message });
	let busy = $state(false);
	const locked = $derived(!!data.locked);
	const base = $derived(`/instances/${encodeURIComponent(data.instance.id)}/players`);
	const samePath = (a: Path, b: Path) => JSON.stringify(a) === JSON.stringify(b);

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
				report(outcome.type === 'success', d?.message ?? '');
			} else {
				report(false, 'Could not save.');
			}
			await refreshAll();
			return outcome.type === 'success';
		} catch {
			report(false, 'Could not reach MineShell.');
			return false;
		} finally {
			busy = false;
		}
	}

	const save = (edits: Record<string, unknown>[]) => post('edit', { edits: JSON.stringify(edits) });

	// ---- fields (built-in and mapped), saved together
	const builtIn = $derived(data.view.fields);
	const mapped = $derived(data.customFields.filter((c) => c.field).map((c) => c.field!) as Field[]);
	let values = $state<Record<string, string | boolean | number>>({});
	$effect(() => {
		values = Object.fromEntries([...builtIn, ...mapped].map((f) => [f.key, f.value]));
	});
	const changed = $derived([...builtIn, ...mapped].filter((f) => String(values[f.key]) !== String(f.value)));

	async function saveFields(event: SubmitEvent) {
		event.preventDefault();
		if (changed.length === 0) return;
		await save(
			changed.map((f) =>
				f.kind === 'list'
					? { op: 'setList', path: f.path, values: String(values[f.key]).split('\n') }
					: { op: 'set', path: f.path, value: f.kind === 'checkbox' ? (values[f.key] ? '1' : '0') : String(values[f.key]) }
			)
		);
	}

	// ---- mapped fields: add from the tree, remap in place
	let mapping = $state<{ path: Path; label: string; kind: string } | null>(null);
	let remapping = $state<CustomField | null>(null);

	const kindFor = (tag: TreeTag) =>
		tag.type === 'list' ? 'list' : tag.type === 'string' ? 'text' : tag.type === 'byte' ? 'checkbox' : 'number';
	const fieldAction = $derived(
		locked
			? null
			: remapping
				? {
						label: `Use for “${remapping.label}”`,
						run: async (path: Path, tag: TreeTag) => {
							const field = remapping!;
							// A list needs a list field, a value a value field; otherwise the field keeps its kind.
							const kind =
								tag.type === 'list' ? 'list' : field.kind === 'list' ? kindFor(tag) : field.kind !== 'text' && tag.type === 'string' ? 'text' : field.kind;
							if (await post('remapField', { id: String(field.id), path: JSON.stringify(path), kind })) remapping = null;
						}
					}
				: {
						label: 'Field',
						run: (path: Path, tag: TreeTag, name: string) => {
							mapping = { path, label: name, kind: kindFor(tag) };
							// Picked inside the item editor: the form is on the page under it.
							stack = [];
							requestAnimationFrame(() => document.querySelector('.map-form')?.scrollIntoView({ block: 'center' }));
						}
					}
	);

	async function addMapped(event: SubmitEvent) {
		event.preventDefault();
		if (mapping && (await post('addField', { label: mapping.label, kind: mapping.kind, path: JSON.stringify(mapping.path) }))) mapping = null;
	}

	// ---- searching the raw tree (a short pause after typing, so big files stay quick)
	let search = $state('');
	let query = $state('');
	$effect(() => {
		const text = search.trim().toLowerCase();
		const timer = setTimeout(() => (query = text), 150);
		return () => clearTimeout(timer);
	});
	const matchCount = $derived(query ? countMatches(data.view.tree, query) : 0);

	// The same for the open item's own data, in the item editor.
	let itemSearch = $state('');
	let itemQuery = $state('');
	$effect(() => {
		const text = itemSearch.trim().toLowerCase();
		const timer = setTimeout(() => (itemQuery = text), 150);
		return () => clearTimeout(timer);
	});

	// ---- effects
	let effectEdits = $state<Record<string, { level: number; seconds: number }>>({});
	$effect(() => {
		effectEdits = Object.fromEntries(data.view.effects.effects.map((e) => [JSON.stringify(e.path), { level: e.level, seconds: e.seconds }]));
	});
	let newEffect = $state({ id: '', level: 1, seconds: 60 });

	async function saveEffect(effect: (typeof data.view.effects.effects)[number]) {
		const edit = effectEdits[JSON.stringify(effect.path)];
		await save([
			{ op: 'set', path: effect.levelPath, value: String(Number(edit.level) - 1) },
			{ op: 'set', path: effect.durationPath, value: String(Number(edit.seconds) < 0 ? -1 : Number(edit.seconds) * 20) }
		]);
	}

	async function addNewEffect(event: SubmitEvent) {
		event.preventDefault();
		if (await save([{ op: 'addEffect', id: newEffect.id, level: Number(newEffect.level), seconds: Number(newEffect.seconds) }])) {
			newEffect = { id: '', level: 1, seconds: 60 };
		}
	}

	// ---- inventory and containers
	let tab = $state<'inventory' | 'ender'>('inventory');
	/** The editor's tabs; Inventory and Ender chest share the grid view. */
	type View = 'inventory' | 'ender' | 'player' | 'effects' | 'data' | 'backups';
	let view = $state<View>('inventory');
	const VIEWS: { id: View; label: string }[] = [
		{ id: 'inventory', label: 'Inventory' },
		{ id: 'ender', label: 'Ender chest' },
		{ id: 'player', label: 'Player' },
		{ id: 'effects', label: 'Effects' },
		{ id: 'data', label: 'All data' }
	];
	function show(next: View) {
		view = next;
		if (next === 'inventory' || next === 'ender') {
			tab = next;
			stack = [];
		}
	}
	// Remapping a field means picking a value in All data.
	$effect(() => {
		if (remapping || mapping) view = 'data';
	});

	/** Online players' files are read-only; kicking them (over RCON) frees it. */
	async function kick() {
		if (!data.name) return;
		const body = new FormData();
		body.set('name', data.name);
		body.set('reason', 'Your player data is being edited');
		const res = await fetch(`${base}?/kick`, { method: 'POST', body, headers: { accept: 'application/json', 'x-sveltekit-action': 'true' } });
		const outcome = deserialize(await res.text());
		if (outcome.type === 'success') report(true, `Kicked ${data.name}. Editing unlocks once the server has saved them.`);
		else report(false, 'Could not kick them over RCON.');
		await refreshAll();
	}
	/** The slots opened, outermost first: a backpack, then a slot inside it. */
	let stack = $state<Loc[]>([]);
	const current = $derived(stack.at(-1) ?? null);
	// The item editor sits beside the grid while a slot is open; Escape closes it.
	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && stack.length) stack = [];
	}

	function allContainers(): Container[] {
		const out: Container[] = [];
		const visit = (cs: Container[]) => {
			for (const c of cs) {
				out.push(c);
				for (const i of c.items) visit(i.containers);
			}
		};
		visit(data.view.containers);
		for (const i of data.view.items) visit(i.containers);
		return out;
	}

	function itemAt(loc: Loc): Item | null {
		if (loc.kind === 'slot') return data.view.items.find((i) => i.section === loc.section && i.slot === loc.slot) ?? null;
		return allContainers().find((c) => samePath(c.path, loc.list))?.items.find((i) => i.slot === loc.slot) ?? null;
	}

	function sameLoc(a: Loc | null, b: Loc): boolean {
		if (!a || a.kind !== b.kind || a.slot !== b.slot) return false;
		return a.kind === 'slot' ? a.section === (b as typeof a).section : samePath(a.list, (b as typeof a).list);
	}

	const selectedItem = $derived(current ? itemAt(current) : null);

	let itemId = $state('');
	let itemCount = $state<string | number>('1');
	let itemDamage = $state<string | number>('0');
	let itemName = $state('');
	let itemLore = $state('');
	let itemUnbreakable = $state(false);
	let itemDurability = $state<string | number>('0');
	let itemEnchants = $state<{ id: string; level: number }[]>([]);

	function fillItemForm() {
		const item = current ? itemAt(current) : null;
		itemId = item?.id ?? '';
		itemCount = item?.count ?? 1;
		itemDamage = item?.damage ?? 0;
		itemName = item?.fields.name ?? '';
		itemLore = item?.fields.lore.join('\n') ?? '';
		itemUnbreakable = item?.fields.unbreakable ?? false;
		itemDurability = item?.fields.damage ?? 0;
		itemEnchants = (item?.fields.enchantments ?? []).map((e) => ({ ...e }));
	}

	function pick(loc: Loc, nested = false) {
		stack = nested ? [...stack, loc] : [loc];
		itemSearch = '';
		fillItemForm();
	}

	function back(to: number) {
		stack = stack.slice(0, to + 1);
		itemSearch = '';
		fillItemForm();
	}

	const legacy = $derived(data.view.format === 'legacy');

	async function saveItem(event: SubmitEvent) {
		event.preventDefault();
		if (!current) return;
		const place =
			current.kind === 'slot'
				? { op: 'item', section: current.section, slot: current.slot }
				: { op: 'containerItem', list: current.list, slot: current.slot };
		const item = selectedItem;
		// Damage only when it changed (or the item is new), so an item without one is not given one.
		const damageChanged = legacy && (!item || Number(itemDamage) !== (item.damage ?? 0));
		const edits: Record<string, unknown>[] = [{ ...place, id: itemId, count: Number(itemCount), ...(damageChanged ? { damage: Number(itemDamage) } : {}) }];
		if (item) {
			// Only what changed, so an untouched field keeps its exact text and formatting.
			const fields: Record<string, unknown> = {};
			if (itemName !== (item.fields.name ?? '')) fields.name = itemName || null;
			const lore = itemLore === '' ? [] : itemLore.split('\n');
			if (lore.join('\n') !== item.fields.lore.join('\n')) fields.lore = lore;
			if (itemUnbreakable !== item.fields.unbreakable) fields.unbreakable = itemUnbreakable;
			if (!legacy && Number(itemDurability) !== (item.fields.damage ?? 0)) fields.damage = Number(itemDurability);
			const enchants = itemEnchants.filter((e) => e.id.trim()).map((e) => ({ id: e.id.trim(), level: Number(e.level) }));
			if (JSON.stringify(enchants) !== JSON.stringify(item.fields.enchantments)) fields.enchantments = enchants;
			if (Object.keys(fields).length) edits.push({ op: 'itemFields', item: item.path, fields });
		}
		if (await save(edits)) fillItemForm();
	}

	async function removeItem() {
		if (!current) return;
		const edit =
			current.kind === 'slot'
				? { op: 'removeItem', section: current.section, slot: current.slot }
				: { op: 'containerRemove', list: current.list, slot: current.slot };
		if (await save([edit])) {
			stack = stack.slice(0, -1);
			fillItemForm();
		}
	}

	function subtree(path: Path): TreeTag | null {
		let tag: TreeTag | undefined = data.view.tree;
		for (const key of path) {
			if (tag?.type === 'compound') tag = tag.value.find(([k]) => k === key)?.[1];
			else if (tag?.type === 'list' && typeof key === 'number') tag = tag.value[key];
			else return null;
		}
		return tag ?? null;
	}

	function locLabel(loc: Loc): string {
		if (loc.kind === 'container') return `slot ${loc.slot}`;
		if (loc.section === 'ender') return `Ender chest slot ${loc.slot}`;
		return SLOT_LABELS[loc.slot] ?? `${loc.slot < 9 ? 'Hotbar' : 'Inventory'} slot ${loc.slot}`;
	}

	/** The name part of an id (the full id is in the slot's tooltip). */
	const LEGACY_NAMES = $derived(data.view.legacyEnchantments);
	const short = (id: string) => (id.split(':').pop() ?? id).replace(/_/g, ' ');
	const SLOT_LABELS: Record<number, string> = { 103: 'Head', 102: 'Chest', 101: 'Legs', 100: 'Feet', [-106]: 'Offhand' };
	const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
	const FORMAT_LABEL = { legacy: 'Minecraft 1.12 and older', flat: 'Minecraft 1.13 to 1.20.4', components: 'Minecraft 1.20.5 and newer' };
	let containerFilter = $state<Record<string, string>>({});
	/**
	 * Real inventories (fixed slots, not too many) start open; open-ended
	 * item lists - ProjectE's knowledge holds every item ever learned - start
	 * closed. Inside an item, anything small opens.
	 */
	const startsOpen = (c: Container, nested: boolean) => c.items.length <= 54 && (c.size === null ? nested : c.size <= 54);

	/** A container without slots (a bundle) shows its items plus one empty place to add to. */
	const containerSlots = (c: Container) => (c.size === null ? range(0, c.items.length) : range(0, c.size - 1));
</script>

<svelte:head><title>{data.name ?? data.uuid} - Players - MineShell</title></svelte:head>

{#snippet cell(loc: Loc, label: string | null = null, nested = false)}
	{@const item = itemAt(loc)}
	<button
		type="button"
		class="slot"
		class:filled={!!item}
		aria-pressed={sameLoc(current, loc)}
		title={item ? `${item.id}${item.name ? ` "${item.name}"` : ''}${item.count > 1 ? ` x${item.count}` : ''}` : `Empty${label ? ` (${label})` : ''}`}
		onclick={() => pick(loc, nested)}
	>
		{#if item}
			<span class="item-name">{item.name ?? short(item.id)}</span>
			{#if item.count > 1}<span class="count">{item.count}</span>{/if}
			{#if item.containers.length}<span class="holds" aria-label="holds items">▣</span>
			{:else if item.hasData}<span class="data-dot" aria-label="has extra data"></span>{/if}
		{:else if label}
			<span class="slot-label">{label}</span>
		{/if}
	</button>
{/snippet}

{#snippet containerGrid(c: Container, nested: boolean)}
	{@const key = JSON.stringify(c.path)}
	{@const filter = (containerFilter[key] ?? '').trim().toLowerCase()}
	<details class="container" open={startsOpen(c, nested)}>
		<summary class="small">
			<span class="container-label">{c.label}</span>
			<span class="faint">
				· {c.items.length} item{c.items.length === 1 ? '' : 's'}{c.size === null ? ', no fixed slots' : ` in ${c.size} slots`}
			</span>
		</summary>
		{#if c.items.length > 54}
			<input class="container-filter" type="search" placeholder="Filter by name or id" bind:value={containerFilter[key]} />
		{/if}
		<div class="grid wide">
			{#each containerSlots(c) as slot (slot)}
				{@const item = itemAt({ kind: 'container', list: c.path, slot })}
				{#if !filter || (item && `${item.id} ${item.name ?? ''}`.toLowerCase().includes(filter))}
					{@render cell({ kind: 'container', list: c.path, slot }, null, nested)}
				{/if}
			{/each}
		</div>
	</details>
{/snippet}

{#snippet input(f: Field)}
	<div class="field" class:check={f.kind === 'checkbox'}>
		{#if f.kind === 'checkbox'}
			<label class="check"><input type="checkbox" bind:checked={values[f.key] as boolean} disabled={locked} /> {f.label}</label>
		{:else}
			<label for="f-{f.key}">{f.label}</label>
			{#if f.kind === 'list'}
				<textarea
					id="f-{f.key}"
					class="mono"
					rows={Math.min(8, String(values[f.key] ?? '').split('\n').length + 1)}
					bind:value={values[f.key]}
					disabled={locked}
				></textarea>
				<p class="hint">One entry per line.</p>
			{:else if f.kind === 'select'}
				<select id="f-{f.key}" bind:value={values[f.key]} disabled={locked}>
					{#each f.options ?? [] as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
				</select>
			{:else}
				<input
					id="f-{f.key}"
					class:mono={f.kind === 'text'}
					type={f.kind === 'number' && !/Array$/.test(f.type) ? 'number' : 'text'}
					step="any"
					bind:value={values[f.key]}
					disabled={locked}
				/>
			{/if}
		{/if}
		{#if f.hint}<p class="hint">{f.hint}</p>{/if}
	</div>
{/snippet}

<svelte:window onkeydown={onKeydown} />

<div class="editor-head">
	<a class="back" href={base}>← All players</a>
	<header class="head">
		<span class="avatar" style="--hue: {avatarTone(data.name ?? data.uuid)}" aria-hidden="true"></span>
		<div class="who">
			<div class="who-name">
				<h2>{data.name ?? 'Unknown name'}</h2>
				{#if data.online}<span class="online"><span class="dot running"></span>Online</span>{/if}
			</div>
			<p class="small faint">
				<span class="mono">{data.uuid}</span>{data.file ? ` · saved ${formatRelative(data.file.modifiedAt)}` : ''} · {FORMAT_LABEL[data.view.format]} data{data.view
					.dataVersion !== null
					? ` (DataVersion ${data.view.dataVersion})`
					: ''}
			</p>
		</div>
		<div class="button-row">
			<button type="button" class="button-quiet" aria-pressed={view === 'backups'} onclick={() => show('backups')}>
				Backups ({data.backups.length})
			</button>
			{#if data.file}
				<a class="button" href="/api/instances/{encodeURIComponent(data.instance.id)}/files?path={encodeURIComponent(data.file.path)}"
					>Download .dat</a
				>
			{/if}
		</div>
	</header>
	<nav class="subtabs" aria-label="Player data sections">
		{#each VIEWS as v (v.id)}
			<button type="button" aria-current={view === v.id ? 'page' : undefined} onclick={() => show(v.id)}>{v.label}</button>
		{/each}
	</nav>
</div>

{#if data.locked}
	<div class="notice warning spread">
		<p>{data.locked}</p>
		{#if data.online && data.name}<button type="button" onclick={kick} disabled={busy}>Kick to edit</button>{/if}
	</div>
{/if}

{#if view === 'player'}
<form class="panel" onsubmit={saveFields}>
	<h2>Player</h2>
	<div class="fields">
		{#each builtIn.filter((f) => f.group === 'basic') as f (f.key)}{@render input(f)}{/each}
	</div>

	{#if data.customFields.length}
		<h3>Your fields</h3>
		<p class="small muted">Mapped from the data below; the same fields show for every player of this server.</p>
		<div class="fields">
			{#each data.customFields as c (c.id)}
				<div class="custom" class:missing={!c.field}>
					{#if c.field}
						{@render input(c.field as Field)}
					{:else}
						<span class="label-text">{c.label}</span>
						<p class="small">{c.problem}</p>
						<p class="mono small faint">{c.path.join(' › ')}</p>
					{/if}
					<span class="custom-actions">
						<button type="button" class="button-quiet" disabled={locked} onclick={() => (remapping = c)}>Remap</button>
						<button type="button" class="button-quiet button-danger" disabled={busy} onclick={() => post('removeField', { id: String(c.id) })}>Remove</button>
					</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if builtIn.some((f) => f.group !== 'basic')}
		<details class="advanced">
			<summary>Advanced</summary>
			<div class="fields">
				{#each builtIn.filter((f) => f.group === 'advanced') as f (f.key)}{@render input(f)}{/each}
			</div>
			{#if builtIn.some((f) => f.group === 'attributes')}
				<h3>Attributes (base values)</h3>
				<div class="fields">
					{#each builtIn.filter((f) => f.group === 'attributes') as f (f.key)}{@render input(f)}{/each}
				</div>
			{/if}
		</details>
	{/if}

	<div class="save-row">
		<button class="button-primary" type="submit" disabled={locked || busy || changed.length === 0}>
			Save{changed.length ? ` ${changed.length} change${changed.length === 1 ? '' : 's'}` : ''}
		</button>
		<p class="small faint">Any value in All data can become a field here: hover it and pick “Field”.</p>
	</div>
</form>
{:else if view === 'effects'}
<section class="panel">
	<h2>Effects</h2>
	{#if data.view.effects.effects.length === 0}
		<p class="small muted">No active effects.</p>
	{:else}
		<table class="effects">
			<thead><tr><th>Effect</th><th>Level</th><th>Seconds left</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
			<tbody>
				{#each data.view.effects.effects as e (JSON.stringify(e.path))}
					{@const edit = effectEdits[JSON.stringify(e.path)]}
					<tr>
						<td class="mono small">{e.id}</td>
						<td>{#if edit}<input type="number" min="1" max="128" bind:value={edit.level} aria-label="Level" disabled={locked} />{/if}</td>
						<td>{#if edit}<input type="number" min="-1" bind:value={edit.seconds} aria-label="Seconds left" disabled={locked} />{/if}</td>
						<td class="right">
							<button type="button" disabled={locked || busy || (edit?.level === e.level && edit?.seconds === e.seconds)} onclick={() => saveEffect(e)}>Save</button>
							<button type="button" class="button-danger" disabled={locked || busy} onclick={() => save([{ op: 'remove', path: e.path }])}>Remove</button>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
	<form class="add-effect" onsubmit={addNewEffect}>
		<div class="field">
			<label for="effect-id">Add an effect</label>
			<input id="effect-id" class="mono" bind:value={newEffect.id} placeholder={data.view.effects.numericIds ? 'minecraft:speed or 1' : 'minecraft:speed'} required disabled={locked} />
		</div>
		<div class="field small-field">
			<label for="effect-level">Level</label>
			<input id="effect-level" type="number" min="1" max="128" bind:value={newEffect.level} disabled={locked} />
		</div>
		<div class="field small-field">
			<label for="effect-seconds">Seconds</label>
			<input id="effect-seconds" type="number" min="-1" bind:value={newEffect.seconds} disabled={locked} />
		</div>
		<button type="submit" disabled={locked || busy}>Add</button>
	</form>
	<p class="hint">-1 seconds lasts forever.</p>
</section>
{:else if view === 'inventory' || view === 'ender'}
<section class="panel">
	<div class="inv-head">
		<p class="small faint">▣ marks an item that holds items; pick it to open what is inside.</p>
	</div>

	<div class="inv-layout">
		<div class="grids">
			{#if tab === 'inventory'}
				<div class="equip">
					{#each [103, 102, 101, 100] as slot (slot)}{@render cell({ kind: 'slot', section: 'armor', slot }, SLOT_LABELS[slot])}{/each}
					<span class="gap"></span>
					{@render cell({ kind: 'slot', section: 'offhand', slot: -106 }, 'Offhand')}
				</div>
				<div class="grid">{#each range(9, 35) as slot (slot)}{@render cell({ kind: 'slot', section: 'main', slot })}{/each}</div>
				<div class="grid hotbar">{#each range(0, 8) as slot (slot)}{@render cell({ kind: 'slot', section: 'main', slot })}{/each}</div>
				{#each data.view.containers as c (JSON.stringify(c.path))}
					{@render containerGrid(c, false)}
				{/each}
			{:else}
				<div class="grid">{#each range(0, 26) as slot (slot)}{@render cell({ kind: 'slot', section: 'ender', slot })}{/each}</div>
			{/if}
		</div>

		<aside class="item-panel" aria-label="Item">
			{#if current}
			<form class="item-editor" onsubmit={saveItem}>
				<button type="button" class="dialog-close button-quiet" aria-label="Close" onclick={() => (stack = [])}>×</button>
				<nav class="crumbs small">
					{#each stack as loc, i (i)}
						{#if i > 0}<span class="faint sep">›</span>{/if}
						{#if i < stack.length - 1}
							<button type="button" class="link" onclick={() => back(i)}>{itemAt(loc) ? short(itemAt(loc)!.id) : locLabel(loc)}</button>
						{:else}
							<strong>{locLabel(loc)}</strong>
						{/if}
					{/each}
				</nav>

				<div class="item-main">
				<div class="field">
					<label for="item-id">Item id</label>
					<input id="item-id" class="mono" bind:value={itemId} placeholder="minecraft:diamond" required disabled={locked} />
				</div>
				<div class="item-row">
					<div class="field narrow">
						<label for="item-count">Count</label>
						<input id="item-count" type="number" min="1" bind:value={itemCount} disabled={locked} />
					</div>
					{#if legacy}
						<div class="field narrow">
							<label for="item-damage">Damage</label>
							<input id="item-damage" type="number" bind:value={itemDamage} disabled={locked} />
						</div>
					{/if}
				</div>

				{#if selectedItem}
					<div class="field">
						<label for="item-name">Name</label>
						<input id="item-name" bind:value={itemName} placeholder="No custom name" disabled={locked} />
					</div>
					<div class="field">
						<label for="item-lore">Lore (one line per line)</label>
						<textarea id="item-lore" rows="2" bind:value={itemLore} disabled={locked}></textarea>
					</div>
					<div class="item-row">
						<label class="check"><input type="checkbox" bind:checked={itemUnbreakable} disabled={locked} /> Unbreakable</label>
						{#if !legacy}
							<div class="field narrow">
								<label for="item-durability">Durability used</label>
								<input id="item-durability" type="number" min="0" bind:value={itemDurability} disabled={locked} />
							</div>
						{/if}
					</div>
					<div class="field">
						<span class="label-text">{selectedItem.fields.stored ? 'Stored enchantments' : 'Enchantments'}</span>
						{#each itemEnchants as e, i (i)}
							<div class="enchant">
								<input class="mono" bind:value={e.id} placeholder={legacy ? '16 (sharpness)' : 'minecraft:sharpness'} aria-label="Enchantment" disabled={locked} />
								<input type="number" min="1" max="255" bind:value={e.level} aria-label="Level" disabled={locked} />
								{#if legacy && LEGACY_NAMES[Number(e.id)]}<span class="small faint enchant-name">{LEGACY_NAMES[Number(e.id)]}</span>{/if}
								<button type="button" class="button-quiet button-danger" aria-label="Remove enchantment" disabled={locked} onclick={() => itemEnchants.splice(i, 1)}>×</button>
							</div>
						{/each}
						<button type="button" class="button-quiet" disabled={locked} onclick={() => itemEnchants.push({ id: '', level: 1 })}>Add enchantment</button>
						{#if legacy}<p class="hint">1.12 numbers enchantments: 0 protection, 16 sharpness, 32 efficiency, 34 unbreaking, 70 mending.</p>{/if}
					</div>
				{/if}

				<div class="buttons">
					<button class="button-primary" type="submit" disabled={locked || busy}>{selectedItem ? 'Save item' : 'Add item'}</button>
					{#if selectedItem}
						<button class="button-danger" type="button" disabled={locked || busy} onclick={removeItem}>Remove</button>
					{/if}
					<button type="button" onclick={() => (stack = [])}>Close</button>
				</div>
				</div>

				{#if selectedItem}
					<div class="item-side">
					{#each selectedItem.containers as c (JSON.stringify(c.path))}
						{@render containerGrid(c, true)}
					{/each}
					{#if subtree(selectedItem.path)}
						{@const tree = subtree(selectedItem.path)!}
						<details class="item-data" open={selectedItem.containers.length === 0}>
							<summary class="small">All item data</summary>
							<div class="tree-search">
								<input type="search" placeholder="Search keys and values" bind:value={itemSearch} aria-label="Search the item’s data" />
								{#if itemQuery}
									{@const found = countMatches(tree, itemQuery)}
									<span class="small muted">{found} match{found === 1 ? '' : 'es'}</span>
								{/if}
							</div>
							<ul class="tree">
								<NbtNode name={short(selectedItem.id)} tag={tree} path={selectedItem.path} {locked} {fieldAction} query={itemQuery} open onEdit={(edit) => save([edit])} />
							</ul>
						</details>
					{/if}
					</div>
				{/if}
			</form>
			{:else}
				<p class="faint small pick">Pick a slot to see and change its item.</p>
			{/if}
		</aside>
	</div>
</section>
{/if}



{#if view === 'data'}
<section class="panel" class:remapping={!!remapping}>
	<h2>All data</h2>
	{#if remapping}
		<div class="notice info remap-notice">
			<p>Pick the value “{remapping.label}” should show: hover it and choose “Use for “{remapping.label}””.</p>
			<button type="button" onclick={() => (remapping = null)}>Cancel</button>
		</div>
	{:else}
		<p class="small muted">
			Everything in the player's file, including what mods store there. Hover an entry to edit, rename, add to or remove
			it, edit it as SNBT, or show it as a field above. Each change is saved on its own.
		</p>
	{/if}
	{#if mapping}
		<form class="map-form" onsubmit={addMapped}>
			<span class="small">New field for <code>{mapping.path.join(' › ')}</code></span>
			<input bind:value={mapping.label} aria-label="Field name" required />
			<select bind:value={mapping.kind} aria-label="Shown as">
				{#if mapping.kind === 'list'}
					<option value="list">List, one entry per line</option>
				{:else}
					<option value="number">Number</option>
					<option value="checkbox">Checkbox</option>
					<option value="text">Text</option>
				{/if}
			</select>
			<button class="button-primary" type="submit" disabled={busy}>Add field</button>
			<button type="button" onclick={() => (mapping = null)}>Cancel</button>
			{#if mapping.path.some((k) => typeof k === 'number')}
				<p class="hint">This goes through a list position, which can point at another entry once that list changes.</p>
			{/if}
		</form>
	{/if}
	<div class="tree-search">
		<input type="search" placeholder="Search keys and values" bind:value={search} aria-label="Search the data" />
		{#if query}<span class="small muted">{matchCount} match{matchCount === 1 ? '' : 'es'}</span>{/if}
	</div>
	<ul class="tree">
		{#each data.view.tree.type === 'compound' ? data.view.tree.value : [] as [key, value], i (`${key}:${i}`)}
			<NbtNode name={key} tag={value} path={[key]} {locked} {fieldAction} {query} onEdit={(edit) => save([edit])} />
		{/each}
	</ul>
</section>
{:else if view === 'backups'}
<section class="panel">
	<h2>Backups</h2>
	<p class="small muted">MineShell keeps the file as it was before each editing session (the newest 10).</p>
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
{/if}

<style>
	.editor-head {
		margin: calc(var(--space-5) * -1) -2.5rem 1.25rem;
		padding: 0.9rem 2.5rem 0;
		border-bottom: 1px solid var(--line);
	}

	.back {
		font-size: 0.87rem;
		text-decoration: none;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.9rem;
		margin: 0.6rem 0 0.4rem;
	}

	.avatar {
		width: 40px;
		height: 40px;
		flex: none;
		border-radius: 4px;
		background: var(--hue);
	}

	.who {
		flex: 1;
		min-width: 0;
	}

	.who-name {
		display: flex;
		align-items: center;
		gap: 0.7rem;
	}

	.who p {
		margin: 0.15rem 0 0;
	}

	.online {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		color: var(--accent-hover);
	}

	.notice.spread {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.notice.spread p {
		margin: 0;
	}

	@media (max-width: 60rem) {
		.editor-head {
			margin: calc(var(--space-4) * -1) calc(var(--space-4) * -1) 1.25rem;
			padding: 0.9rem var(--space-4) 0;
		}
	}

	.head {
		margin-bottom: var(--space-4);
	}

	.head h2,
	.head p {
		margin: 0;
	}

	h3 {
		font-size: 0.95rem;
		margin: var(--space-4) 0 var(--space-1);
	}

	.fields {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: var(--space-3);
	}

	.fields .field {
		margin: 0;
		width: 9.5rem;
	}

	.fields .field:has(textarea) {
		width: 16rem;
	}

	.fields textarea {
		width: 100%;
		margin: 0;
	}

	.fields .field.check {
		align-self: center;
	}

	.fields .hint {
		margin-top: 0.15rem;
	}

	.check {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--text);
		font-size: 0.88rem;
		margin: 0;
	}

	.custom {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.custom.missing {
		width: 12rem;
		opacity: 0.7;
		border: 1px dashed var(--line-strong);
		border-radius: var(--radius);
		padding: var(--space-2);
	}

	.custom.missing p {
		margin: 0;
	}

	.custom-actions {
		display: flex;
		gap: var(--space-1);
	}

	.custom-actions button {
		font-size: 0.72rem;
		padding: 0.05rem 0.4rem;
	}

	.advanced {
		margin-top: var(--space-4);
	}

	.advanced summary {
		cursor: pointer;
		margin-bottom: var(--space-3);
	}

	.save-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-top: var(--space-4);
	}

	.save-row p {
		margin: 0;
	}

	.label-text {
		display: block;
		font-size: 0.85rem;
		color: var(--text-muted);
		margin-bottom: var(--space-1);
	}

	.effects input {
		width: 6rem;
		margin: 0;
	}

	.effects td button {
		font-size: 0.78rem;
		padding: 0.2rem 0.5rem;
	}

	.right {
		text-align: right;
	}

	.add-effect {
		display: flex;
		align-items: flex-end;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-top: var(--space-3);
	}

	.add-effect .field {
		margin: 0;
	}

	.small-field {
		width: 6rem;
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

	.hotbar {
		margin-top: var(--space-1);
	}

	.container {
		margin-top: var(--space-2);
	}

	.container summary {
		cursor: pointer;
		margin-bottom: var(--space-2);
	}

	.container-label {
		color: var(--text-muted);
	}

	.container-filter {
		max-width: 18rem;
		margin: 0 0 var(--space-2);
	}

	/* Containers other than the inventory: wide cells across the width, so names fit. */
	.grid.wide {
		grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
	}

	.grid.wide .slot {
		width: auto;
		height: 3rem;
		padding: 2px 6px;
	}

	.grid.wide .item-name {
		font-size: 0.74rem;
		-webkit-line-clamp: 2;
		line-clamp: 2;
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

	.holds {
		position: absolute;
		top: 0;
		right: 3px;
		font-size: 0.65rem;
		color: var(--accent);
	}

	.inv-layout {
		display: grid;
		grid-template-columns: auto minmax(20rem, 1fr);
		gap: 1.25rem;
		align-items: start;
	}

	/* The item editor, beside the grid while a slot is open. */
	.item-panel {
		position: sticky;
		top: 13rem;
		max-height: calc(100vh - 14rem);
		overflow-y: auto;
		min-width: 0;
		padding: 1.1rem 1.25rem;
		background: var(--panel-raised);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
	}

	.pick {
		margin: 0;
		text-align: center;
		padding: 2rem 0;
	}

	@media (max-width: 1100px) {
		.inv-layout {
			grid-template-columns: minmax(0, 1fr);
		}

		.item-panel {
			position: static;
			max-height: none;
		}
	}

	.item-editor {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		column-gap: var(--space-5);
	}

	.crumbs {
		grid-column: 1 / -1;
	}

	.item-side > .container:first-child {
		margin-top: 0;
	}

	.crumbs {
		margin-bottom: var(--space-3);
		padding-right: 2rem;
	}

	.dialog-close {
		position: absolute;
		top: -0.4rem;
		right: -0.6rem;
		font-size: 1.2rem;
		line-height: 1;
		padding: 0.2rem 0.55rem;
	}

	.enchant-name {
		align-self: center;
		white-space: nowrap;
	}

	.sep {
		margin: 0 0.35rem;
	}

	.link {
		background: none;
		border: 0;
		padding: 0;
		color: var(--accent);
		font-weight: normal;
		font-size: inherit;
	}

	.item-row {
		display: flex;
		align-items: flex-end;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}

	.item-row .field {
		margin: 0;
	}

	.narrow {
		width: 7rem;
	}

	.enchant {
		display: flex;
		gap: var(--space-1);
		margin-bottom: var(--space-1);
	}

	.enchant input {
		margin: 0;
	}

	.enchant input[type='number'] {
		width: 5rem;
	}

	.buttons {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.item-data {
		margin-top: var(--space-4);
	}

	.item-data summary {
		cursor: pointer;
	}

	.tree {
		margin: 0;
		padding: 0;
	}

	.tree-search {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin-bottom: var(--space-3);
	}

	.tree-search input {
		max-width: 22rem;
		margin: 0;
	}

	.remap-notice {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.remap-notice p {
		margin: 0;
	}

	.map-form {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
		padding: var(--space-2) var(--space-3);
		margin-bottom: var(--space-3);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
	}

	.map-form input,
	.map-form select {
		margin: 0;
		width: auto;
	}

	.map-form .hint {
		flex-basis: 100%;
		margin: 0;
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
