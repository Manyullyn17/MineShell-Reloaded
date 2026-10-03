<script lang="ts">
	import NbtNode from './NbtNode.svelte';
	import type { Path, TreeTag } from '$lib/server/playerdata';

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
		open: startOpen = false
	}: {
		name: string;
		tag: TreeTag;
		path: Path;
		locked: boolean;
		onEdit: (edit: Record<string, unknown>) => Promise<boolean>;
		open?: boolean;
	} = $props();

	// svelte-ignore state_referenced_locally
	let open = $state(startOpen);
	let editing = $state(false);
	let draft = $state('');
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

	const ADDABLE = ['string', 'byte', 'short', 'int', 'long', 'float', 'double', 'compound', 'list', 'byteArray', 'intArray', 'longArray'];
	const listType = $derived(tag.type === 'list' && tag.value.length ? tag.itemType : null);

	function startEdit() {
		draft = isArray ? (tag.value as unknown[]).join(', ') : String(tag.value);
		editing = true;
	}

	async function saveEdit() {
		if (await onEdit({ op: 'set', path, value: draft })) editing = false;
	}

	async function remove() {
		await onEdit({ op: 'remove', path });
	}

	async function add() {
		const type = listType ?? newType;
		const ok = await onEdit({ op: 'add', path, name: newName, type, value: newValue });
		if (ok) {
			adding = false;
			newName = '';
			newValue = '';
			open = true;
		}
	}
</script>

<li>
	<div class="row">
		{#if container}
			<button class="toggle" type="button" aria-expanded={open} onclick={() => (open = !open)}>{open ? '▾' : '▸'}</button>
		{:else}
			<span class="toggle"></span>
		{/if}
		<span class="name mono">{name}</span>
		<span class="type">{tag.type === 'list' ? `list of ${tag.itemType === 'end' ? 'nothing yet' : tag.itemType}` : tag.type}</span>
		{#if editing}
			<form
				class="edit"
				onsubmit={(e) => {
					e.preventDefault();
					void saveEdit();
				}}
			>
				<input class="mono" bind:value={draft} aria-label="New value" />
				<button type="submit" class="button-primary">Save</button>
				<button type="button" onclick={() => (editing = false)}>Cancel</button>
			</form>
		{:else}
			<span class="value mono" class:muted={container}>{shown}</span>
			{#if !locked}
				<span class="actions">
					{#if !container}<button type="button" class="button-quiet" onclick={startEdit}>Edit</button>{/if}
					{#if container}<button type="button" class="button-quiet" onclick={() => ((adding = !adding), (open = true))}>Add</button>{/if}
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
						{#if listType}
							<span class="type">{listType}</span>
						{:else}
							<select bind:value={newType} aria-label="Type">
								{#each ADDABLE as t (t)}<option value={t}>{t}</option>{/each}
							</select>
						{/if}
						{#if !['compound', 'list'].includes(listType ?? newType)}
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
					{locked}
					{onEdit}
				/>
			{/each}
		</ul>
	{/if}
</li>

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

	.edit input {
		flex: 1 1 auto;
	}

	.add input[placeholder='name'] {
		width: 9rem;
	}

	.add input[placeholder='value'] {
		flex: 1 1 auto;
	}
</style>
