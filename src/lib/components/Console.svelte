<script lang="ts">
	import { onDestroy } from 'svelte';
	import { appendLine, matchesFilter, type ConsoleEntry, type Level } from '#lib/shared/consolelines.js';
	import { fitToViewport } from '#lib/shared/fitToViewport.js';

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
	const counts = $derived.by(() => {
		const n: Record<Level | 'player', number> = { error: 0, warn: 0, info: 0, debug: 0, player: 0 };
		for (const line of lines) {
			if (line.level) n[line.level]++;
			if (line.player) n.player++;
		}
		return n;
	});
	let below: HTMLElement | null = $state(null);
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

	/** The log's own "[13:02:11] " prefix goes in the time column; the rest is the line. */
	function splitTime(text: string): { time: string; rest: string } {
		const m = text.match(/^\[(\d\d:\d\d:\d\d)(?:\.\d+)?\] ?/);
		return m ? { time: m[1], rest: text.slice(m[0].length) } : { time: '', rest: text };
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
		<span class="stream" class:connected>
			<span class="dot" class:running={connected} class:failed={!connected}></span>
			{connected ? 'Streaming from the journal' : 'Not connected'}
		</span>
		<span class="divider" aria-hidden="true"></span>
		{#each LEVELS as level (level.id)}
			<button
				type="button"
				class="chip"
				data-level={level.id}
				aria-pressed={shownLevels[level.id]}
				onclick={() => (shownLevels[level.id] = !shownLevels[level.id])}
			>
				<span class="swatch"></span>{level.label}<span class="count">{counts[level.id]}</span>
			</button>
		{/each}
		<button
			type="button"
			class="chip"
			data-level="player"
			aria-pressed={playersOnly}
			title="Show only players joining and leaving"
			onclick={() => (playersOnly = !playersOnly)}
		>
			<span class="swatch"></span>Joins &amp; leaves<span class="count">{counts.player}</span>
		</button>
		<button
			type="button"
			class="chip"
			data-level="rcon"
			aria-pressed={rconConnections}
			title="The server logs every RCON connection; MineShell opens several a minute"
			onclick={() => (rconConnections = !rconConnections)}
		>
			<span class="swatch"></span>RCON connections
		</button>
		<span class="spacer"></span>
		<span class="search">
			<span aria-hidden="true">⌕</span>
			<input type="search" bind:value={search} placeholder="Search the output" aria-label="Search the output" />
		</span>
		{#if filtering}
			<span class="faint small">{visible.length} of {lines.length}</span>
		{/if}
		<button class="button-quiet" type="button" aria-pressed={autoscroll} onclick={() => (autoscroll = !autoscroll)}>
			{autoscroll ? 'Following' : 'Follow output'}
		</button>
		<button class="button-quiet" type="button" onclick={copyAll} disabled={visible.length === 0}>
			{copied ? 'Copied' : filtering ? 'Copy shown' : 'Copy'}
		</button>
		<button class="button-quiet" type="button" onclick={() => ((lines = []), (open = {}))}>Clear view</button>
	</div>

	{#if error}
		<p class="notice warning small">{error}</p>
	{/if}

	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<!-- tabindex is deliberate: a scrollable region must be reachable by keyboard. -->
	<div
		class="viewport"
		bind:this={viewport}
		onscroll={onScroll}
		tabindex="0"
		role="log"
		use:fitToViewport={{ bottomMarginPx: 20, reserveElement: below }}
	>
		{#if lines.length === 0}
			<p class="faint">Waiting for output. Nothing is logged while the server is stopped.</p>
		{:else if visible.length === 0}
			<p class="faint">No line matches the filters.</p>
		{:else}
			{#each visible as line (line.id)}
				{@const split = splitTime(line.text)}
				<div class="entry">
					<span class="time">{split.time}</span>
					<div>
						<div class="line" data-tone={line.tone}>{#each segments(split.rest, search) as part, i (i)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</div>
						{#if line.trace.length}
							<button class="trace-toggle" onclick={() => (open[line.id] = !open[line.id])} aria-expanded={!!open[line.id]}>
								{open[line.id] ? '▾ hide the stack trace' : `▸ ${line.trace.length} more line${line.trace.length === 1 ? '' : 's'}`}
							</button>
							{#if open[line.id]}
								<div class="trace">
									{#each line.trace as traceLine, i (i)}
										<div class="line">{#each segments(traceLine, search) as part, j (j)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</div>
									{/each}
								</div>
							{/if}
						{/if}
					</div>
				</div>
			{/each}
		{/if}
	</div>

	<div class="below" bind:this={below}>
		{#if macroList.length}
			<div class="macros" aria-label="Saved commands">
				<span class="faint">Saved</span>
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
				placeholder={canSend ? 'Type a server command, e.g. say hello   ·   ↑ for history' : 'Start the server to send commands'}
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
</div>

<style>
	.console {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.bar {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.stream {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.87rem;
		color: var(--error);
	}

	.stream.connected {
		color: var(--accent-hover);
	}

	.divider {
		width: 1px;
		height: 18px;
		background: var(--line-strong);
		margin: 0 0.25rem;
	}

	.spacer {
		flex: 1;
	}

	.chip {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.2rem 0.65rem;
		border-radius: 12px;
		font-size: 0.83rem;
		font-weight: 400;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--text-faint);
		--swatch: var(--text-muted);
	}

	.chip[aria-pressed='true'] {
		background: var(--panel);
		border-color: var(--line-strong);
		color: var(--text);
	}

	.chip[data-level='error'] {
		--swatch: var(--error);
	}
	.chip[data-level='warn'] {
		--swatch: var(--warning);
	}
	.chip[data-level='debug'] {
		--swatch: var(--text-faint);
	}
	.chip[data-level='player'] {
		--swatch: var(--accent);
	}
	.chip[data-level='rcon'] {
		--swatch: var(--info);
	}

	.swatch {
		width: 7px;
		height: 7px;
		border-radius: 1px;
		background: var(--swatch);
	}

	.count {
		font-family: var(--font-mono);
		font-size: 0.73rem;
		color: var(--text-faint);
	}

	.search {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 14rem;
		background: var(--bg-sunken);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
		padding: 0 0.55rem;
		color: var(--text-faint);
		font-size: 0.87rem;
	}

	.search input {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: 0;
		padding: 0.3rem 0;
		font-size: 0.87rem;
		outline: none;
	}

	.viewport {
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		padding: 0.75rem 0.9rem;
		min-height: 16rem;
		height: 100vh;
		overflow: auto;
		font-family: var(--font-mono);
		font-size: 0.83rem;
		line-height: 1.6;
	}

	.entry {
		display: grid;
		grid-template-columns: 4.1rem minmax(0, 1fr);
		gap: 0.75rem;
	}

	.time {
		color: var(--text-faint);
		opacity: 0.75;
	}

	.line {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
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
	.line[data-tone='player'] {
		color: var(--accent-hover);
	}

	.trace {
		padding-left: 0.9rem;
		border-left: 2px solid var(--line);
	}

	.trace .line {
		color: var(--text-muted);
	}

	mark {
		background: color-mix(in srgb, var(--warning) 35%, transparent);
		color: inherit;
		border-radius: 2px;
	}

	.trace-toggle {
		display: block;
		padding: 0;
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

	.below {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.macros {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.8rem;
	}

	.macro {
		display: inline-flex;
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
	}

	.macro button {
		font-family: var(--font-mono);
		font-size: 0.8rem;
		font-weight: 400;
		padding: 0.15rem 0.55rem;
		border-radius: 0;
		color: var(--text);
	}

	.macro .remove {
		color: var(--text-faint);
		border-left: 1px solid var(--line);
	}

	.input-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		background: var(--bg-sunken);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-lg);
		padding: 4px 4px 4px 0.75rem;
	}

	.prompt {
		font-family: var(--font-mono);
		color: var(--accent);
	}

	.input-row input {
		flex: 1;
		background: transparent;
		border: 0;
		padding: 0.45rem 0;
		font-family: var(--font-mono);
		font-size: 0.88rem;
		outline: none;
	}
</style>
