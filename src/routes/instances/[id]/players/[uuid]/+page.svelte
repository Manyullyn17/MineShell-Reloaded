<script lang="ts">
	import { tick } from 'svelte';
	import { avatarTone } from '#lib/shared/avatar.js';
	import { deserialize } from '$app/forms';
	import { refreshAll } from '$app/navigation';
	import NbtNode from '#lib/components/NbtNode.svelte';
	import ItemIcon from '#lib/components/ItemIcon.svelte';
	import { iconKey, iconLoader } from '#lib/shared/itemicon.svelte.js';
	import { formatDateTime, formatRelative } from '#lib/shared/format.js';
	import { countMatches, type Path, type TreeTag } from '#lib/shared/nbt.js';
	import { toast } from '#lib/shared/toasts.svelte.js';

	let { data } = $props();

	// Item pictures (lib/server/itemicons.ts): drawn once per item, the name kept as text where there is none.
	// svelte-ignore state_referenced_locally
	const icons = iconLoader(data.instance.id);
	let pictured = $state<Record<string, boolean>>({});

	// The item picker: every item the server knows, loaded the first time it is used.
	let allItems = $state.raw<{ id: string; name: string }[] | null>(null);
	let findQuery = $state('');
	async function loadItems() {
		if (allItems) return;
		const res = await fetch(`/api/instances/${encodeURIComponent(data.instance.id)}/item-icons/items`);
		allItems = res.ok ? (await res.json()).items : [];
	}
	const FOUND_SHOWN = 60;
	/**
	 * Every word typed anywhere in the name or id ("copper ingot" finds Ingot
	 * Copper and thermalfoundation's ingot_copper). Ranked, not cut by rank:
	 * the name starting with it, a word of it starting with it, then the rest.
	 */
	const found = $derived.by(() => {
		const q = findQuery.trim().toLowerCase();
		if (q.length < 2 || !allItems) return { items: [], total: 0 };
		const words = q.split(/\s+/);
		const hits = allItems.filter((i) => {
			const text = `${i.name} ${i.id}`.toLowerCase();
			return words.every((w) => text.includes(w));
		});
		const rank = (i: { name: string; id: string }) => {
			const name = i.name.toLowerCase();
			if (name.startsWith(q)) return 0;
			if (words.every((w) => new RegExp(`(^|[\\s:_./-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(`${name} ${i.id}`))) return 1;
			return 2;
		};
		const sorted = hits.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
		return { items: sorted.slice(0, FOUND_SHOWN), total: sorted.length };
	});

	// ---- the tooltip, on hover (desktop): as the game shows it, with the id as F3+H does.
	type Hovered = { item: NonNullable<ReturnType<typeof itemAt>>; x: number; y: number; variant: boolean };
	// Raw: the item is compared by identity, which a deep proxy would break.
	let hovered = $state.raw<Hovered | null>(null);
	const canHover = typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
	const itemNames = $derived(new Map((allItems ?? []).map((i) => [i.id, i.name])));
	$effect(() => {
		// The names the tooltip shows come with the picker's list.
		if (canHover) void loadItems();
	});
	function hover(event: MouseEvent, loc: Loc) {
		const item = itemAt(loc);
		if (!canHover || !item) {
			hovered = null;
			return;
		}
		const at = { x: event.clientX, y: event.clientY };
		if (hovered?.item === item) {
			hovered = { ...hovered, ...at };
			return;
		}
		hovered = { item, ...at, variant: false };
		void icons.icon(item.id, item.damage).then((icon) => {
			if (hovered?.item === item) hovered = { ...hovered, variant: icon.variant };
		});
	}
	const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
	const enchantLine = (e: { id: string; level: number }) => {
		const name = legacy ? (LEGACY_NAMES[Number(e.id)]?.name ?? `Enchantment ${e.id}`) : short(e.id).replace(/\b\w/g, (c) => c.toUpperCase());
		return `${name} ${ROMAN[e.level] ?? e.level}`;
	};
	const durabilityLine = (h: Hovered) => {
		const used = legacy ? h.item.damage : h.item.fields.damage;
		if (h.item.maxDamage) return `Durability: ${h.item.maxDamage - (used ?? 0)} / ${h.item.maxDamage}`;
		if (!used) return null;
		return legacy && h.variant ? `Variant ${used}` : `Damage ${used}`;
	};

	async function acceptIconEula() {
		const res = await fetch('?/iconEula', { method: 'POST', headers: { 'x-sveltekit-action': 'true' }, body: new FormData() });
		if (res.ok) {
			pictured = {};
			icons.reset();
			await refreshAll();
		}
	}

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

	// On a phone the editor is a sheet over the lower part of the screen: the picked slot
	// is brought up above it, so the grid stays in reach for picking the next one.
	$effect(() => {
		if (!current || !matchMedia('(max-width: 60rem)').matches) return;
		void tick().then(() => {
			const slot = document.querySelector('.slot[aria-pressed="true"]');
			// The player's own grid fits above the sheet whole; a slot in a long container list is brought up itself.
			const target = slot?.closest('.grid.wide') ? slot : (slot?.closest('.grids')?.firstElementChild ?? slot);
			target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
		});
	});

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
	/** The world's enchantments for the picker, by name; the mod in the label tells same-named ones apart. */
	const legacyOptions = $derived(
		Object.entries(LEGACY_NAMES)
			.map(([number, e]) => {
				const mod = e.id.split(':')[0];
				return { number, label: mod === 'minecraft' ? e.name : `${e.name} · ${mod}`, id: e.id };
			})
			.sort((a, b) => a.label.localeCompare(b.label))
	);
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

	type Group = { id: string; label: string; containers: Container[] };
	/** Containers in file order, those of one group (Curios' slot types) together at the first one's place. */
	function arrange(containers: Container[]): (Container | Group)[] {
		const out: (Container | Group)[] = [];
		const groups = new Map<string, Group>();
		for (const c of containers) {
			if (!c.group) {
				out.push(c);
				continue;
			}
			let g = groups.get(c.group.id);
			if (!g) {
				g = { id: c.group.id, label: c.group.label, containers: [] };
				groups.set(g.id, g);
				out.push(g);
			}
			g.containers.push(c);
		}
		return out;
	}
	const isGroup = (x: Container | Group): x is Group => 'containers' in x;
	/** Groups showing their empty lists too (Curios: mostly cosmetic slots nobody uses). */
	let showEmpty = $state<Record<string, boolean>>({});
</script>

<svelte:head><title>{data.name ?? data.uuid} - Players - MineShell</title></svelte:head>

{#if hovered}
	{@const h = hovered}
	<div class="tooltip" role="tooltip" style:left="{h.x + 14}px" style:top="{h.y + 14}px">
		<div class="tip-name" class:custom={!!h.item.name}>{h.item.name ?? itemNames.get(h.item.id) ?? short(h.item.id)}</div>
		{#each h.item.fields.enchantments as e, i (i)}<div class="tip-enchant">{enchantLine(e)}</div>{/each}
		{#each h.item.fields.lore as line, i (i)}<div class="tip-lore">{line}</div>{/each}
		{#if h.item.fields.unbreakable}<div class="tip-blue">Unbreakable</div>{/if}
		{#if durabilityLine(h)}<div>{durabilityLine(h)}</div>{/if}
		{#if h.item.energy !== null}<div>Energy: {h.item.energy.toLocaleString()} FE</div>{/if}
		{#if h.item.count > 1}<div class="tip-dim">Count: {h.item.count}</div>{/if}
		<div class="tip-id">{h.item.id}{legacy && h.item.damage ? `:${h.item.damage}` : ''}</div>
	</div>
{/if}

{#snippet cell(loc: Loc, label: string | null = null, nested = false, wide = false)}
	{@const item = itemAt(loc)}
	<button
		type="button"
		class="slot"
		class:filled={!!item}
		aria-pressed={sameLoc(current, loc)}
		title={canHover && item ? undefined : item ? `${item.id}${item.name ? ` "${item.name}"` : ''}${item.count > 1 ? ` x${item.count}` : ''}` : `Empty${label ? ` (${label})` : ''}`}
		aria-label={item ? `${item.name ?? itemNames.get(item.id) ?? short(item.id)}${item.count > 1 ? `, ${item.count}` : ''}` : `Empty${label ? ` (${label})` : ''}`}
		onclick={() => pick(loc, nested)}
		onmouseenter={(e) => hover(e, loc)}
		onmousemove={(e) => hover(e, loc)}
		onmouseleave={() => (hovered = null)}
	>
		{#if item}
			<ItemIcon loader={icons} id={item.id} damage={item.damage} size={32} onresult={(shown) => (pictured[iconKey(item.id, item.damage)] = shown)} />
			<!-- In a list (wide on a phone) the name goes next to the picture; elsewhere only without one. -->
			{#if wide || !pictured[iconKey(item.id, item.damage)]}
				<span class="item-name" class:beside={wide && pictured[iconKey(item.id, item.damage)]}>{item.name ?? itemNames.get(item.id) ?? short(item.id)}</span>
			{/if}
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
					{@render cell({ kind: 'container', list: c.path, slot }, null, nested, true)}
				{/if}
			{/each}
		</div>
	</details>
{/snippet}

{#snippet containerGroup(g: Group, nested: boolean)}
	{@const filled = g.containers.filter((c) => c.items.length)}
	{@const items = filled.reduce((n, c) => n + c.items.length, 0)}
	{@const empty = g.containers.length - filled.length}
	{@const shown = showEmpty[g.id] ? g.containers : filled}
	<details class="container group">
		<summary class="small">
			<span class="container-label">{g.label}</span>
			<span class="faint">· {items} item{items === 1 ? '' : 's'} in {g.containers.length} list{g.containers.length === 1 ? '' : 's'}</span>
		</summary>
		{#if empty}
			<label class="check small faint show-empty">
				<input type="checkbox" bind:checked={showEmpty[g.id]} /> Show the {empty} empty one{empty === 1 ? '' : 's'}
			</label>
		{/if}
		{#each shown as c (JSON.stringify(c.path))}
			{#if c.items.length > 54}
				{@render containerGrid(c, nested)}
			{:else}
				<div class="group-row">
					<span class="small muted group-label" title={c.label}>{c.label.replace(/_/g, ' ')}</span>
					<div class="grid wide">
						{#each containerSlots(c) as slot (slot)}{@render cell({ kind: 'container', list: c.path, slot }, null, nested, true)}{/each}
					</div>
				</div>
			{/if}
		{/each}
	</details>
{/snippet}

{#snippet containers(list: Container[], nested: boolean)}
	{#each arrange(list) as x (isGroup(x) ? x.id : JSON.stringify(x.path))}
		{#if isGroup(x)}{@render containerGroup(x, nested)}{:else}{@render containerGrid(x, nested)}{/if}
	{/each}
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
		<p class="small faint">Any value in All data can become a field here: hover (or tap) it and pick “Field”.</p>
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
		{#if !data.iconsEula}
			<p class="small muted icon-eula">
				Pictures of Minecraft's own items come from its client, which means accepting the
				<a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Minecraft EULA</a> (the same answer as the Map tab).
				<button type="button" class="button-quiet small" onclick={acceptIconEula}>Accept and show them</button>
			</p>
		{/if}
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
				{@render containers(data.view.containers, false)}
			{:else}
				<div class="grid">{#each range(0, 26) as slot (slot)}{@render cell({ kind: 'slot', section: 'ender', slot })}{/each}</div>
			{/if}
		</div>

		<aside class="item-panel" class:open={!!current} aria-label="Item">
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
					<div class="id-row">
						{#if itemId}<ItemIcon loader={icons} id={itemId} damage={itemDamage === '' || itemDamage === null ? null : Number(itemDamage)} size={40} />{/if}
						<input id="item-id" class="mono" bind:value={itemId} placeholder="minecraft:diamond" required disabled={locked} />
					</div>
					{#if !locked}
						<input
							type="search"
							class="find"
							placeholder="Find an item by name"
							aria-label="Find an item by name"
							bind:value={findQuery}
							onfocus={loadItems}
						/>
						{#if findQuery.trim().length >= 2}
							<ul class="found" role="listbox" aria-label="Items">
								{#if !allItems}
									<li class="muted small">Reading the server's items.</li>
								{:else if !found.total}
									<li class="muted small">No item matches.</li>
								{/if}
								{#each found.items as choice (choice.id)}
									<li>
										<button
											type="button"
											role="option"
											aria-selected={choice.id === itemId}
											onclick={() => {
												itemId = choice.id;
												findQuery = '';
											}}
										>
											<span class="found-icon"><ItemIcon loader={icons} id={choice.id} size={24} /></span>
											<span class="found-name">{choice.name}</span>
											<span class="mono faint found-id">{choice.id}</span>
										</button>
									</li>
								{/each}
								{#if found.total > found.items.length}
									<li class="muted small">{found.total - found.items.length} more; type more to narrow it down.</li>
								{/if}
							</ul>
						{/if}
					{/if}
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
								{#if legacy}
									<!-- 1.12 stores numbers; the picker shows this world's names and writes the number. -->
									<select bind:value={e.id} aria-label="Enchantment" title={LEGACY_NAMES[Number(e.id)]?.id ?? ''} disabled={locked}>
										{#if !LEGACY_NAMES[Number(e.id)] || e.id.trim() === ''}
											<option value={e.id}>{e.id.trim() === '' ? 'Pick an enchantment' : `Unknown (${e.id})`}</option>
										{/if}
										{#each legacyOptions as o (o.number)}<option value={o.number}>{o.label}</option>{/each}
									</select>
								{:else}
									<input class="mono" bind:value={e.id} placeholder="minecraft:sharpness" aria-label="Enchantment" disabled={locked} />
								{/if}
								<input type="number" min="1" max="255" bind:value={e.level} aria-label="Level" disabled={locked} />
								<button type="button" class="button-quiet button-danger" aria-label="Remove enchantment" disabled={locked} onclick={() => itemEnchants.splice(i, 1)}>×</button>
							</div>
						{/each}
						<button type="button" class="button-quiet" disabled={locked} onclick={() => itemEnchants.push({ id: '', level: 1 })}>Add enchantment</button>
						{#if legacy}<p class="hint">{legacyOptions.length} enchantments in this world's table.</p>{/if}
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
					{@render containers(selectedItem.containers, true)}
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
			Everything in the player's file, including what mods store there. Hover (or tap) an entry to edit, rename, add to or remove
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
		flex-wrap: wrap;
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
		flex: 1 1 14rem;
		min-width: 0;
	}

	/* A UUID has no spaces; it breaks anywhere rather than one segment per line. */
	.who .mono {
		word-break: break-all;
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
		flex-wrap: wrap;
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
		/* Nine across, shrinking on a phone instead of running off the screen. */
		grid-template-columns: repeat(9, minmax(0, 3.75rem));
		gap: 3px;
	}

	.grid:not(.wide) .slot,
	.equip .slot {
		width: 100%;
		height: auto;
		aspect-ratio: 1;
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

	.show-empty {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		margin-bottom: var(--space-2);
	}

	.group-row {
		display: grid;
		grid-template-columns: 9rem minmax(0, 1fr);
		gap: var(--space-2);
		align-items: center;
		margin-bottom: 3px;
	}

	.group-label {
		overflow-wrap: anywhere;
	}

	@media (max-width: 60rem) {
		.group-row {
			grid-template-columns: minmax(0, 1fr);
			gap: 2px;
			margin-bottom: var(--space-2);
		}
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
		display: flex;
		align-items: center;
		justify-content: flex-start;
		gap: 0.4rem;
	}

	.grid.wide .item-name {
		font-size: 0.74rem;
		text-align: left;
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

	/* As the game draws it: dark, a purple edge, the name on top, the id faint at the bottom. */
	.tooltip {
		position: fixed;
		z-index: 60;
		max-width: 22rem;
		padding: 0.35rem 0.55rem;
		background: rgb(16 0 16 / 0.94);
		border: 2px solid #2d0d63;
		outline: 1px solid rgb(16 0 16 / 0.94);
		border-radius: 3px;
		color: #fff;
		font-size: 0.82rem;
		line-height: 1.35;
		pointer-events: none;
		overflow-wrap: anywhere;
	}

	.tip-name {
		margin-bottom: 0.15rem;
	}

	.tip-name.custom {
		font-style: italic;
		color: #55ffff;
	}

	.tip-enchant,
	.tip-dim {
		color: #aaaaaa;
	}

	.tip-lore {
		color: #aa00aa;
		font-style: italic;
	}

	.tip-blue {
		color: #5555ff;
	}

	.tip-id {
		margin-top: 0.15rem;
		color: #555555;
		font-family: var(--font-mono);
		font-size: 0.74rem;
	}

	/*
	 * Item lists: wide cells with the name next to the picture on a phone; on a
	 * desktop, inventory-sized slots like the inventory, the name in the tooltip.
	 */
	@media (hover: hover) and (pointer: fine) {
		.grid.wide {
			grid-template-columns: repeat(auto-fill, 3.75rem);
		}

		.grid.wide .slot {
			width: 3.75rem;
			height: 3.75rem;
			padding: 2px;
			display: grid;
			/* place-content too: the phone layout's flex-start would push the grid's one column to the left. */
			place-content: center;
			place-items: center;
		}

		.grid.wide .item-name {
			text-align: center;
			font-size: 0.62rem;
			-webkit-line-clamp: 3;
			line-clamp: 3;
		}

		.grid.wide .item-name.beside {
			display: none;
		}
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

	.id-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.id-row input {
		flex: 1;
		min-width: 0;
	}

	.find {
		margin-top: var(--space-1);
		width: 100%;
	}

	.found {
		list-style: none;
		margin: var(--space-1) 0 0;
		padding: 2px;
		max-height: 18rem;
		overflow-y: auto;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--bg-sunken);
	}

	.found li.muted {
		padding: 0.4rem 0.6rem;
	}

	.found button {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		padding: 0.25rem 0.5rem;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text);
		font-weight: 400;
		text-align: left;
	}

	.found button:hover,
	.found button[aria-selected='true'] {
		background: var(--panel);
	}

	.found-icon {
		width: 24px;
		height: 24px;
		flex: none;
	}

	.found-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.found-id {
		font-size: 0.72rem;
		flex: none;
		max-width: 45%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.icon-eula {
		margin: var(--space-1) 0 0;
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

	/* On a phone the item opens in a sheet over the bottom of the screen, instead of
	   below every container list where a tap seemed to do nothing. */
	@media (max-width: 60rem) {
		.item-panel {
			display: none;
		}

		.item-panel.open {
			display: block;
			position: fixed;
			top: auto;
			left: 0;
			right: 0;
			bottom: 0;
			z-index: 30;
			max-height: 60vh;
			border-radius: var(--radius-lg) var(--radius-lg) 0 0;
			border-bottom: 0;
			padding: 1rem var(--space-4) calc(1rem + env(safe-area-inset-bottom));
			box-shadow: 0 -12px 32px rgb(0 0 0 / 0.4);
		}

		/* Room to scroll the picked slot up above the sheet, and clear of the top bar. */
		.inv-layout:has(.item-panel.open) {
			padding-bottom: 60vh;
		}

		.slot,
		.grids > * {
			scroll-margin-top: 4.5rem;
		}

		.fields .field {
			width: calc(50% - var(--space-3) / 2);
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

	.enchant input,
	.enchant select {
		margin: 0;
		min-width: 0;
	}

	.enchant select {
		flex: 1 1 auto;
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
