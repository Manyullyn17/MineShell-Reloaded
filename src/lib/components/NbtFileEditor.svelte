<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import NbtNode from '#lib/components/NbtNode.svelte';
	import { formatBytes, formatDateTime, formatRelative } from '#lib/shared/format.js';
	import type { Path, TreeTag } from '#lib/shared/nbt.js';

	/**
	 * An NBT file opened from Files (nbtfiles.ts, /api/instances/[id]/nbt): the tree as the
	 * player editor shows it, sent in parts for big files, searched on the server. Each change is
	 * saved on its own; the list or compound it was in comes back as it is now.
	 */

	type Container = Extract<TreeTag, { type: 'list' | 'compound' }>;
	type View = {
		path: string;
		rootName: string;
		gzipped: boolean;
		bytes: number;
		version: string;
		tree: TreeTag;
		readOnly: string | null;
		versions: { id: string; savedAt: number; bytes: number }[];
	};
	type Match = { path: Path; positions: number[]; type: string; value: string };

	let { instanceId, view }: { instanceId: string; view: View } = $props();

	// The page keys this on the file and its version: a new view is a new editor.
	// svelte-ignore state_referenced_locally
	let tree = $state(view.tree as Container);
	// svelte-ignore state_referenced_locally
	let version = $state(view.version);
	let message = $state<{ ok: boolean; text: string } | null>(null);
	/** The file changed on disk under the page (the server, a mod, another tab). */
	let stale = $state(false);
	let busy = $state(false);

	const locked = $derived(!!view.readOnly || stale);
	const api = $derived(`/api/instances/${encodeURIComponent(instanceId)}/nbt`);

	function nodeAt(at: Path): Container | null {
		let node: TreeTag = tree;
		for (const key of at) {
			if (node.type === 'compound') {
				const found: [string, TreeTag] | undefined = node.value.find(([k]) => k === key);
				if (!found) return null;
				node = found[1];
			} else if (node.type === 'list' && typeof key === 'number' && node.value[key]) node = node.value[key];
			else return null;
		}
		return node.type === 'compound' || node.type === 'list' ? node : null;
	}

	/** The list or compound at `at` takes what the server sent for it (its first entries, or later ones from `from`). */
	function fill(at: Path, fresh: Container, from = 0) {
		const node = nodeAt(at);
		if (!node || node.type !== fresh.type) return;
		(node.value as unknown[]).splice(from, node.value.length - from, ...(fresh.value as unknown[]));
		node.more = fresh.more;
	}

	async function ask(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
		try {
			const res = await fetch(url, init);
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				message = { ok: false, text: body.message ?? 'That did not work.' };
				return null;
			}
			if (typeof body.version === 'string' && body.version !== version && !init?.method) stale = true;
			return body;
		} catch {
			message = { ok: false, text: 'Could not reach MineShell.' };
			return null;
		}
	}

	const query = (params: Record<string, string>) => `${api}?${new URLSearchParams({ path: view.path, ...params })}`;

	async function onLoad(at: Path, upTo?: number) {
		const node = nodeAt(at);
		if (!node) return;
		const from = node.value.length;
		const body = await ask(query({ at: JSON.stringify(at), from: String(from), ...(upTo !== undefined ? { upTo: String(upTo) } : {}) }));
		if (body) fill(at, body.tag as Container, from);
	}

	async function snbtOf(at: Path): Promise<string | null> {
		const body = await ask(query({ at: JSON.stringify(at), snbt: '1' }));
		return body ? String(body.snbt) : null;
	}

	async function onEdit(edit: Record<string, unknown>): Promise<boolean> {
		const path = edit.path as Path;
		// What to show again: the list or compound the change was in (added to, for an add).
		const at = edit.op === 'add' ? path : path.slice(0, -1);
		const loaded = nodeAt(at)?.value.length ?? 0;
		busy = true;
		try {
			const body = await ask(api, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: view.path, version, edits: [edit], refresh: { at, upTo: Math.max(0, loaded) } })
			});
			if (!body) return false;
			version = String(body.version);
			if (body.tag) fill(at, body.tag as Container);
			message = { ok: true, text: 'Saved.' };
			return true;
		} finally {
			busy = false;
		}
	}

	// ---- search, on the server: a big file is not all here
	let search = $state('');
	let searched = $state('');
	let matches = $state<Match[] | null>(null);
	let moreMatches = $state(false);
	let reveal = $state<{ path: Path; positions: number[] } | null>(null);

	async function find(event: SubmitEvent) {
		event.preventDefault();
		const q = search.trim();
		if (!q) {
			matches = null;
			searched = '';
			return;
		}
		const body = await ask(query({ q }));
		if (!body) return;
		matches = body.matches as Match[];
		moreMatches = !!body.more;
		searched = q.toLowerCase();
	}

	const pathText = (path: Path) => path.map((k) => (typeof k === 'number' ? `[${k}]` : k)).join(' › ');

	async function putBack(id: string, savedAt: number) {
		if (!confirm(`Put back the file as it was on ${formatDateTime(savedAt)}? The file as it is now is kept under Earlier versions.`)) return;
		const body = await ask(api, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path: view.path, version, restore: id })
		});
		if (body) await invalidateAll();
	}
</script>

<div class="nbt-editor">
	<p class="faint small facts">
		NBT · {view.gzipped ? 'gzipped' : 'not compressed'} · {formatBytes(view.bytes)}{view.rootName ? ` · root “${view.rootName}”` : ''}
	</p>
	{#if view.readOnly}
		<div class="notice warning"><p>{view.readOnly}</p></div>
	{:else if stale}
		<div class="notice warning">
			<p>The file changed on disk since it was opened. Reload to see it as it is now before changing it.</p>
			<button type="button" onclick={() => invalidateAll()}>Reload</button>
		</div>
	{:else}
		<p class="small muted">
			Hover (or tap) an entry to edit, rename, add to or remove it, or edit it as SNBT. Each change is saved on its own; the
			file as it was before you started is kept under Earlier versions. A wrong value can keep a world or a mod from loading
			its data, so change only what you know.
		</p>
	{/if}
	{#if message}
		<p class="small" class:warn-text={!message.ok} class:muted={message.ok} role={message.ok ? 'status' : 'alert'}>{message.text}</p>
	{/if}

	<form class="tree-search" onsubmit={find}>
		<input type="search" autocomplete="off" placeholder="Search keys and values" bind:value={search} aria-label="Search the file" />
		<button type="submit">Search</button>
		{#if matches}
			<span class="small muted">{matches.length}{moreMatches ? '+' : ''} match{matches.length === 1 ? '' : 'es'}</span>
		{/if}
	</form>
	{#if matches?.length}
		<ul class="matches">
			{#each matches as match (match.positions.join('.'))}
				<li>
					<button type="button" class="button-quiet match" onclick={() => (reveal = { path: match.path, positions: match.positions })}>
						<span class="mono where">{pathText(match.path)}</span>
						{#if match.value}<span class="mono value" title={match.value}>{match.value}</span>{/if}
					</button>
				</li>
			{/each}
		</ul>
		{#if moreMatches}<p class="faint small">The first {matches.length} are listed: search for something more exact to find the rest.</p>{/if}
	{/if}

	<ul class="tree" aria-busy={busy}>
		{#each tree.type === 'compound' ? tree.value : [] as [key, value], i (`${key}:${i}`)}
			<NbtNode name={key} tag={value} path={[key]} {locked} mark={searched} {onEdit} {onLoad} {snbtOf} {reveal} />
		{/each}
		{#if tree.more}
			<li class="faint small">{tree.more} more at the top level are not shown.</li>
		{/if}
	</ul>

	{#if view.versions.length}
		<details class="versions">
			<summary>Earlier versions ({view.versions.length}), kept by changes here</summary>
			<p class="faint small">One for each editing session (ten minutes), the newest 20, for up to 90 days.</p>
			<ul>
				{#each view.versions as v (v.id)}
					<li>
						<span>{formatDateTime(v.savedAt)}</span>
						<span class="faint small">{formatRelative(v.savedAt)} · {formatBytes(v.bytes)}</span>
						<button type="button" class="button-quiet" disabled={locked} onclick={() => putBack(v.id, v.savedAt)}>Put back</button>
					</li>
				{/each}
			</ul>
		</details>
	{/if}
</div>

<style>
	.nbt-editor {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
	}
	.facts {
		margin: 0;
	}
	.tree-search {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.tree-search input {
		flex: 1 1 14rem;
		max-width: 24rem;
		margin: 0;
	}
	.matches {
		margin: 0;
		padding: 0;
		list-style: none;
		max-height: 16rem;
		overflow-y: auto;
		border: 1px solid var(--line);
		border-radius: var(--radius, 6px);
	}
	.match {
		display: flex;
		gap: var(--space-2);
		width: 100%;
		text-align: left;
		font-size: 0.8rem;
		white-space: normal;
		min-width: 0;
	}
	.match .where {
		overflow-wrap: anywhere;
		min-width: 0;
	}
	.match .value {
		color: var(--accent);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		margin-left: auto;
		max-width: 50%;
	}
	@media (max-width: 60rem) {
		.match {
			flex-wrap: wrap;
		}
		.match .value {
			margin-left: 0;
			max-width: 100%;
		}
	}
	.tree {
		margin: 0;
		padding: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.versions ul {
		list-style: none;
		padding: 0;
		margin: var(--space-2) 0 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.versions li {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
</style>
