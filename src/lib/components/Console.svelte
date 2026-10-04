<script lang="ts">
	import { onDestroy } from 'svelte';
	import { appendLine, matchesFilter, type ConsoleEntry, type Level } from '#lib/shared/consolelines.js';

	/**
	 * Output arrives over Server-Sent Events (one long-lived GET) and input goes
	 * out as a normal POST. SSE rather than a WebSocket because SvelteKit serves
	 * it from a plain +server.ts with no custom HTTP server, in dev and in prod.
	 */
	let {
		instanceId,
		bufferLines = 2000,
		canSend = true,
		resetKey = null,
		macros = []
	}: {
		instanceId: string;
		bufferLines?: number;
		canSend?: boolean;
		/** Bump this (any changed value) to clear the view without reconnecting. */
		resetKey?: unknown;
		/** Saved commands for this server (lib/server/macros.ts). */
		macros?: string[];
	} = $props();

	let lines = $state<ConsoleEntry[]>([]);
	let connected = $state(false);
	let error = $state('');
	let command = $state('');
	let autoscroll = $state(true);
	let sending = $state(false);
	let copied = $state(false);
	let viewport: HTMLDivElement | null = $state(null);
	let input: HTMLInputElement | null = $state(null);

	// Filters. Lines without a level (RCON answers, MineShell's notes) only answer to the search.
	const LEVELS: { id: Level; label: string }[] = [
		{ id: 'error', label: 'Errors' },
		{ id: 'warn', label: 'Warnings' },
		{ id: 'info', label: 'Info' },
		{ id: 'debug', label: 'Debug' }
	];
	let shownLevels = $state<Record<Level, boolean>>({ error: true, warn: true, info: true, debug: true });
	let playersOnly = $state(false);
	let search = $state('');
	// Off by default: MineShell's own polling opens an RCON connection several times a minute.
	let rconConnections = $state(false);
	const filter = $derived({
		levels: new Set(LEVELS.filter((l) => shownLevels[l.id]).map((l) => l.id)),
		playersOnly,
		search,
		rconConnections
	});
	const filtering = $derived(filter.levels.size < LEVELS.length || playersOnly || search.trim() !== '');
	const visible = $derived(lines.filter((entry) => matchesFilter(entry, filter)));
	/** Entries whose stack trace is unfolded. */
	let open = $state<Record<number, boolean>>({});

	let nextId = 0;
	let source: EventSource | null = null;

	// Command history survives a reload: per server, in this browser only.
	const HISTORY_SIZE = 100;
	let history: string[] = [];
	let historyIndex = -1;
	const historyKey = (id: string) => `mineshell:console-history:${id}`;

	function loadHistory(id: string) {
		try {
			const saved = JSON.parse(localStorage.getItem(historyKey(id)) ?? '[]');
			history = Array.isArray(saved) ? saved.filter((h) => typeof h === 'string').slice(0, HISTORY_SIZE) : [];
		} catch {
			history = [];
		}
		historyIndex = -1;
	}

	function remember(text: string) {
		history = [text, ...history.filter((h) => h !== text)].slice(0, HISTORY_SIZE);
		historyIndex = -1;
		try {
			localStorage.setItem(historyKey(instanceId), JSON.stringify(history));
		} catch {
			/* private window or storage off: history lasts for this page only */
		}
	}

	function push(text: string) {
		appendLine(lines, text, nextId++);
		if (lines.length > bufferLines) {
			lines.splice(0, lines.length - bufferLines);
		}
	}

	function connect() {
		source?.close();
		source = new EventSource(`/api/instances/${instanceId}/console`);
		source.addEventListener('open', () => {
			connected = true;
			error = '';
		});
		source.addEventListener('line', (event) => {
			push((event as MessageEvent).data);
		});
		source.addEventListener('error', () => {
			connected = false;
			// EventSource retries on its own; the banner just explains the gap.
			error = 'Console disconnected. Reconnecting.';
		});
	}

	$effect(() => {
		// Re-subscribe when the instance changes.
		const id = instanceId;
		lines = [];
		open = {};
		nextId = 0;
		loadHistory(id);
		connect();
		return () => {
			source?.close();
			source = null;
		};
	});

	$effect(() => {
		// Touch the length so this reruns on every appended line.
		visible.length;
		if (autoscroll && viewport) {
			viewport.scrollTop = viewport.scrollHeight;
		}
	});

	$effect(() => {
		// journalctl -f follows the unit straight through a restart, with
		// nothing in the stream itself marking where the old process's
		// output ends and the new one's begins. The console page bumps
		// resetKey as soon as the unit starts leaving "running", so the view
		// is already clear by the time the new process's lines arrive.
		resetKey;
		lines = [];
		open = {};
	});

	function onScroll() {
		if (!viewport) return;
		const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
		autoscroll = distance < 40;
	}

	async function send() {
		const text = command.trim();
		if (!text || sending) return;
		sending = true;
		remember(text);
		command = '';
		try {
			const res = await fetch(`/api/instances/${instanceId}/command`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ command: text })
			});
			const data = await res.json();
			if (!res.ok) {
				push(`[mineshell] ${data.message ?? 'Command failed.'}`);
			} else if (data.response?.trim()) {
				push(`[rcon] ${data.response.trim()}`);
			}
		} catch (err) {
			push(`[mineshell] ${err instanceof Error ? err.message : 'Command failed.'}`);
		} finally {
			sending = false;
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			void send();
			return;
		}
		if (event.key === 'ArrowUp' && history.length) {
			event.preventDefault();
			historyIndex = Math.min(historyIndex + 1, history.length - 1);
			command = history[historyIndex];
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			historyIndex = Math.max(historyIndex - 1, -1);
			command = historyIndex === -1 ? '' : history[historyIndex];
		}
	}

	// ---- macros: saved commands; a click fills the input, Enter sends it.
	let macroList = $state<string[]>([]);
	$effect(() => {
		macroList = [...macros];
	});

	async function saveMacros(next: string[]) {
		const before = macroList;
		macroList = next;
		try {
			const res = await fetch(`/api/instances/${instanceId}/macros`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ macros: next })
			});
			if (!res.ok) throw new Error();
			macroList = (await res.json()).macros;
		} catch {
			macroList = before;
			push('[mineshell] Could not save the saved commands.');
		}
	}

	function useMacro(text: string) {
		command = text;
		input?.focus();
	}

	/** Splits text around the search so matches can be marked. */
	function segments(text: string, query: string): { text: string; hit: boolean }[] {
		const q = query.trim().toLowerCase();
		if (!q) return [{ text, hit: false }];
		const parts: { text: string; hit: boolean }[] = [];
		const lower = text.toLowerCase();
		let at = 0;
		for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + q.length)) {
			if (i > at) parts.push({ text: text.slice(at, i), hit: false });
			parts.push({ text: text.slice(i, i + q.length), hit: true });
			at = i + q.length;
		}
		if (at < text.length) parts.push({ text: text.slice(at), hit: false });
		return parts;
	}

	async function copyAll() {
		// What is shown, traces included: a filtered view copies just that.
		const text = visible.flatMap((l) => [l.text, ...l.trace]).join('\n');
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Clipboard API needs a secure context; over plain http on a LAN IP
			// that is not granted, so fall back to a hidden textarea + execCommand.
			const scratch = document.createElement('textarea');
			scratch.value = text;
			scratch.setAttribute('readonly', '');
			scratch.style.position = 'fixed';
			scratch.style.opacity = '0';
			document.body.appendChild(scratch);
			scratch.select();
			try {
				document.execCommand('copy');
			} finally {
				document.body.removeChild(scratch);
			}
		}
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}

	onDestroy(() => source?.close());
</script>

<div class="console">
	<div class="bar">
		<span class="row small">
			<span class="dot" class:running={connected} class:failed={!connected}></span>
			{connected ? 'Streaming from the journal' : 'Not connected'}
		</span>
		<span class="row">
			<label class="row small" for="autoscroll-{instanceId}">
				<input id="autoscroll-{instanceId}" type="checkbox" bind:checked={autoscroll} />
				Follow output
			</label>
			<button class="button-quiet" onclick={copyAll} disabled={visible.length === 0}>
				{copied ? 'Copied' : filtering ? 'Copy shown' : 'Copy'}
			</button>
			<button class="button-quiet" onclick={() => ((lines = []), (open = {}))}>Clear view</button>
		</span>
	</div>

	<div class="filters">
		{#each LEVELS as level (level.id)}
			<label class="row small" for="level-{level.id}-{instanceId}">
				<input id="level-{level.id}-{instanceId}" type="checkbox" bind:checked={shownLevels[level.id]} />
				{level.label}
			</label>
		{/each}
		<label class="row small" for="players-{instanceId}">
			<input id="players-{instanceId}" type="checkbox" bind:checked={playersOnly} />
			Only players joining and leaving
		</label>
		<label class="row small" for="rcon-{instanceId}" title="The server logs every RCON connection; MineShell opens several a minute">
			<input id="rcon-{instanceId}" type="checkbox" bind:checked={rconConnections} />
			RCON connections
		</label>
		<input class="search" type="search" bind:value={search} placeholder="Search the output" aria-label="Search the output" />
		{#if filtering}
			<span class="faint small">{visible.length} of {lines.length} lines</span>
		{/if}
	</div>

	{#if error}
		<p class="notice warning small">{error}</p>
	{/if}

	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<!-- tabindex is deliberate: a scrollable region must be reachable by keyboard. -->
	<div class="viewport" bind:this={viewport} onscroll={onScroll} tabindex="0" role="log">
		{#if lines.length === 0}
			<p class="faint">Waiting for output. Nothing is logged while the server is stopped.</p>
		{:else if visible.length === 0}
			<p class="faint">No line matches the filters.</p>
		{:else}
			{#each visible as line (line.id)}
				<div class="line" data-tone={line.tone}>{#each segments(line.text, search) as part, i (i)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</div>
				{#if line.trace.length}
					<button class="trace-toggle" onclick={() => (open[line.id] = !open[line.id])} aria-expanded={!!open[line.id]}>
						{open[line.id] ? '▾ hide the stack trace' : `▸ ${line.trace.length} more line${line.trace.length === 1 ? '' : 's'}`}
					</button>
					{#if open[line.id]}
						{#each line.trace as traceLine, i (i)}
							<div class="line trace">{#each segments(traceLine, search) as part, j (j)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</div>
						{/each}
					{/if}
				{/if}
			{/each}
		{/if}
	</div>

	{#if macroList.length}
		<div class="macros" aria-label="Saved commands">
			{#each macroList as macro (macro)}
				<span class="macro">
					<button class="button-quiet" onclick={() => useMacro(macro)} title="Put it in the command line">{macro}</button>
					<button
						class="button-quiet remove"
						onclick={() => saveMacros(macroList.filter((m) => m !== macro))}
						aria-label="Forget {macro}">×</button
					>
				</span>
			{/each}
		</div>
	{/if}

	<form
		class="input-row"
		onsubmit={(e) => {
			e.preventDefault();
			void send();
		}}
	>
		<span class="prompt" aria-hidden="true">&gt;</span>
		<input
			type="text"
			bind:this={input}
			placeholder={canSend ? 'Type a server command, e.g. say hello' : 'Start the server to send commands'}
			bind:value={command}
			onkeydown={onKeydown}
			disabled={!canSend || sending}
			autocomplete="off"
			spellcheck="false"
			aria-label="Server command"
		/>
		<button
			class="button-quiet"
			type="button"
			onclick={() => saveMacros([...macroList, command.trim()])}
			disabled={!command.trim() || macroList.includes(command.trim()) || macroList.length >= 20}
			title="Keep this command as a button above the command line"
		>
			Save
		</button>
		<button class="button-primary" type="submit" disabled={!canSend || sending || !command.trim()}>
			Send
		</button>
	</form>
</div>

<style>
	.console {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.bar label {
		margin: 0;
		cursor: pointer;
	}

	.viewport {
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: var(--space-3);
		height: clamp(20rem, 55vh, 42rem);
		overflow-y: auto;
		overflow-x: auto;
		font-family: var(--font-mono);
		font-size: 0.8rem;
		line-height: 1.5;
	}

	.line {
		white-space: pre;
		color: var(--text);
	}

	.line[data-tone='error'] {
		color: var(--error);
	}
	.line[data-tone='warn'] {
		color: var(--warning);
	}
	.line[data-tone='rcon'] {
		color: var(--info);
	}
	.line[data-tone='meta'] {
		color: var(--text-faint);
	}

	.input-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.prompt {
		font-family: var(--font-mono);
		color: var(--accent);
	}

	.input-row input {
		font-family: var(--font-mono);
		font-size: 0.85rem;
	}
	.line[data-tone='player'] {
		color: var(--accent-hover);
	}

	.line.trace {
		color: var(--text-muted);
	}

	mark {
		background: color-mix(in srgb, var(--warning) 35%, transparent);
		color: inherit;
		border-radius: 2px;
	}

	.trace-toggle {
		display: block;
		padding: 0 0 0 var(--space-4);
		border: 0;
		background: none;
		color: var(--text-faint);
		font: inherit;
		font-size: 0.75rem;
		cursor: pointer;
	}

	.trace-toggle:hover:not(:disabled) {
		color: var(--text);
	}

	.filters {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
	}

	.filters label {
		margin: 0;
		cursor: pointer;
		color: var(--text-muted);
	}

	.filters .search {
		width: auto;
		flex: 1 1 12rem;
		max-width: 20rem;
		font-size: 0.85rem;
		padding: 0.25rem 0.5rem;
	}

	.macros {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}

	.macro {
		display: inline-flex;
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
	}

	.macro button {
		font-family: var(--font-mono);
		font-size: 0.78rem;
		padding: 0.15rem 0.45rem;
		border-radius: 0;
	}

	.macro .remove {
		color: var(--text-faint);
		border-left: 1px solid var(--line);
	}
</style>
