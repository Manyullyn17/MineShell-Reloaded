<script lang="ts">
	import NbtNode from './NbtNode.svelte';
	import { childMatches, selfMatches, treeToSnbt, type Path, type TreeTag } from '#lib/shared/nbt.js';

	/**
	 * One entry of an NBT tree: a value that can be edited or removed in place,
	 * or a compound/list that opens to its entries and can take new ones.
	 * Every change goes out as one edit through `onEdit`, which saves it.
	 */
	let {
		name,
		tag,
		path,
		locked,
		onEdit,
		inList = false,
		fieldAction = null,
		query = '',
		mark = '',
		open: startOpen = false
	}: {
		name: string;
		tag: TreeTag;
		path: Path;
		locked: boolean;
		onEdit: (edit: Record<string, unknown>) => Promise<boolean>;
		/** An entry of a list: no name to change, and its type is the list's. */
		inList?: boolean;
		/** A button on each value: "add as field", or "use for <field>" while remapping one. */
		fieldAction?: { label: string; run: (path: Path, tag: TreeTag, name: string) => void } | null;
		/** Lower-case search text: only entries that match, or hold a match, are shown. */
		query?: string;
		/** Highlighted without filtering: inside a compound shown whole because its key matched. */
		mark?: string;
		open?: boolean;
	} = $props();

	const hit = $derived(!!query && selfMatches(inList ? null : String(name), tag, query));
	const inside = $derived(!!query && childMatches(tag, query));
	// A compound or list found by its own key shows whole, so it can be opened and read.
	const childQuery = $derived(hit ? '' : query);
	const term = $derived(query || mark);
	const marked = $derived(!!term && selfMatches(inList ? null : String(name), tag, term));

	// svelte-ignore state_referenced_locally
	let open = $state(startOpen);
	// Searching opens the way to every match; clearing the search folds it back.
	$effect(() => {
		open = query ? inside : startOpen;
	});
	let editing = $state<false | 'value' | 'snbt' | 'name'>(false);
	let draft = $state('');
	let draftType = $state('');
	let adding = $state(false);
	let newName = $state('');
	let newType = $state('string');
	let newValue = $state('');

	const container = $derived(tag.type === 'compound' || tag.type === 'list');
	const entries = $derived<[string, TreeTag][]>(
		tag.type === 'compound' ? tag.value : tag.type === 'list' ? tag.value.map((v, i) => [String(i), v]) : []
	);
	const isArray = $derived(tag.type === 'byteArray' || tag.type === 'intArray' || tag.type === 'longArray');
	const shown = $derived(
		container
			? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`
			: isArray
				? (tag.value as unknown[]).join(', ')
				: String(tag.value)
	);

	/** Lists a field can show: plain values, or nothing yet. */
	const PLAIN = ['byte', 'short', 'int', 'long', 'float', 'double', 'string', 'end'];
	const PRIMITIVES = ['string', 'byte', 'short', 'int', 'long', 'float', 'double', 'byteArray', 'intArray', 'longArray'];
	const ADDABLE = ['snbt', ...PRIMITIVES, 'compound', 'list'];
	const listType = $derived(tag.type === 'list' && tag.value.length ? tag.itemType : null);

	function startEdit(mode: 'value' | 'snbt' | 'name') {
		draft = mode === 'snbt' ? treeToSnbt(tag, 2) : mode === 'name' ? name : isArray ? (tag.value as unknown[]).join(', ') : String(tag.value);
		draftType = tag.type;
		editing = mode;
	}

	async function saveEdit() {
		const edit =
			editing === 'snbt'
				? { op: 'replace', path, snbt: draft }
				: editing === 'name'
					? { op: 'rename', path, name: draft }
					: { op: 'set', path, value: draft, ...(draftType !== tag.type ? { type: draftType } : {}) };
		if (await onEdit(edit)) editing = false;
	}

	async function remove() {
		await onEdit({ op: 'remove', path });
	}

	async function add() {
		const type = newType === 'snbt' ? 'snbt' : (listType ?? newType);
		const ok = await onEdit({ op: 'add', path, name: newName, type, value: newValue });
		if (ok) {
			adding = false;
			newName = '';
			newValue = '';
			open = true;
		}
	}
</script>

{#if !query || hit || inside}
<li>
	<div class="row">
		{#if container}
			<button class="toggle" type="button" aria-expanded={open} onclick={() => (open = !open)}>{open ? '▾' : '▸'}</button>
		{:else}
			<span class="toggle"></span>
		{/if}
		<span class="name mono" class:hit={marked && !inList && String(name).toLowerCase().includes(term)}>{name}</span>
		<span class="type">{tag.type === 'list' ? `list of ${tag.itemType === 'end' ? 'nothing yet' : tag.itemType}` : tag.type}</span>
		{#if editing}
			<form
				class="edit"
				class:block={editing === 'snbt'}
				onsubmit={(e) => {
					e.preventDefault();
					void saveEdit();
				}}
			>
				{#if editing === 'snbt'}
					<textarea class="mono" rows={Math.min(16, draft.split('\n').length + 1)} bind:value={draft} aria-label="SNBT"></textarea>
				{:else}
					<input class="mono" bind:value={draft} aria-label={editing === 'name' ? 'New name' : 'New value'} />
					{#if editing === 'value' && !inList}
						<select bind:value={draftType} aria-label="Type">
							{#each PRIMITIVES as t (t)}<option value={t}>{t}</option>{/each}
						</select>
					{/if}
				{/if}
				<span class="form-buttons">
					<button type="submit" class="button-primary">Save</button>
					<button type="button" onclick={() => (editing = false)}>Cancel</button>
				</span>
			</form>
		{:else}
			<span class="value mono" class:muted={container} class:hit={marked && !container && shown.toLowerCase().includes(term)}>{shown}</span>
			{#if fieldAction && (!container || (tag.type === 'list' && PLAIN.includes(tag.itemType)))}
				<button type="button" class="button-quiet field-action" onclick={() => fieldAction.run(path, tag, name)}>{fieldAction.label}</button>
			{/if}
			{#if !locked}
				<span class="actions">
					{#if !container}<button type="button" class="button-quiet" onclick={() => startEdit('value')}>Edit</button>{/if}
					{#if container}<button type="button" class="button-quiet" onclick={() => ((adding = !adding), (open = true))}>Add</button>{/if}
					{#if path.length}<button type="button" class="button-quiet" onclick={() => startEdit('snbt')}>SNBT</button>{/if}
					{#if path.length && !inList}<button type="button" class="button-quiet" onclick={() => startEdit('name')}>Rename</button>{/if}
					{#if path.length}<button type="button" class="button-quiet button-danger" onclick={remove}>Remove</button>{/if}
				</span>
			{/if}
		{/if}
	</div>

	{#if container && open}
		<ul>
			{#if adding}
				<li>
					<form
						class="add"
						onsubmit={(e) => {
							e.preventDefault();
							void add();
						}}
					>
						{#if tag.type === 'compound'}
							<input class="mono" placeholder="name" bind:value={newName} aria-label="Name" required />
						{/if}
						<select bind:value={newType} aria-label="Type">
							{#each listType ? ['snbt', listType] : ADDABLE as t (t)}<option value={t}>{t === 'snbt' ? 'SNBT (paste)' : t}</option>{/each}
						</select>
						{#if newType === 'snbt'}
							<textarea class="mono" rows="3" placeholder={'{id:"minecraft:sharpness",lvl:5s}'} bind:value={newValue} aria-label="SNBT"></textarea>
						{:else if !['compound', 'list'].includes(newType)}
							<input class="mono" placeholder="value" bind:value={newValue} aria-label="Value" />
						{/if}
						<button type="submit" class="button-primary">Add</button>
						<button type="button" onclick={() => (adding = false)}>Cancel</button>
					</form>
				</li>
			{/if}
			{#each entries as [key, value], i (`${key}:${i}`)}
				<NbtNode
					name={key}
					tag={value}
					path={[...path, tag.type === 'list' ? i : key]}
					inList={tag.type === 'list'}
					query={childQuery}
					mark={term}
					{fieldAction}
					{locked}
					{onEdit}
				/>
			{/each}
		</ul>
	{/if}
</li>
{/if}

<style>
	li {
		list-style: none;
	}

	ul {
		margin: 0;
		padding-left: 1.1rem;
		border-left: 1px solid var(--line);
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 1.9rem;
		font-size: 0.85rem;
	}

	.row:hover {
		background: var(--panel-raised);
	}

	.toggle {
		width: 1.2rem;
		flex: 0 0 1.2rem;
		padding: 0;
		border: 0;
		background: none;
		color: var(--text-muted);
	}

	.name {
		color: var(--text);
	}

	.hit {
		background: color-mix(in srgb, var(--accent) 28%, transparent);
		border-radius: 3px;
		padding: 0 2px;
	}

	.type {
		font-size: 0.72rem;
		color: var(--text-faint);
	}

	.value {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--accent);
	}

	.value.muted {
		color: var(--text-muted);
	}

	.actions {
		margin-left: auto;
		display: flex;
		gap: var(--space-1);
		visibility: hidden;
	}

	.row:hover .actions,
	.row:focus-within .actions {
		visibility: visible;
	}

	.field-action {
		font-size: 0.72rem;
		padding: 0.05rem 0.4rem;
		visibility: hidden;
	}

	.row:hover .field-action,
	.field-action:focus-visible,
	:global(.remapping) .field-action {
		visibility: visible;
	}

	.actions button,
	form button {
		font-size: 0.75rem;
		padding: 0.1rem 0.45rem;
	}

	form {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		flex: 1 1 auto;
	}

	form input,
	form select {
		font-size: 0.8rem;
		padding: 0.15rem 0.4rem;
		margin: 0;
	}

	.edit input,
	textarea {
		flex: 1 1 auto;
	}

	form.block {
		flex-direction: column;
		align-items: stretch;
		padding: var(--space-1) 0;
	}

	textarea {
		font-size: 0.8rem;
		margin: 0;
		min-width: 18rem;
	}

	.form-buttons {
		display: flex;
		gap: var(--space-1);
	}

	.add input[placeholder='name'] {
		width: 9rem;
	}

	.add input[placeholder='value'] {
		flex: 1 1 auto;
	}
</style>
