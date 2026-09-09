<script lang="ts">
	import { onDestroy } from 'svelte';

	/**
	 * Output arrives over Server-Sent Events (one long-lived GET) and input goes
	 * out as a normal POST. SSE rather than a WebSocket because SvelteKit serves
	 * it from a plain +server.ts with no custom HTTP server, in dev and in prod.
	 */
	let {
		instanceId,
		bufferLines = 2000,
		canSend = true
	}: { instanceId: string; bufferLines?: number; canSend?: boolean } = $props();

	type Line = { id: number; text: string; tone: string };

	let lines = $state<Line[]>([]);
	let connected = $state(false);
	let error = $state('');
	let command = $state('');
	let autoscroll = $state(true);
	let sending = $state(false);
	let copied = $state(false);
	let viewport: HTMLDivElement | null = $state(null);

	let nextId = 0;
	let source: EventSource | null = null;
	const history: string[] = [];
	let historyIndex = -1;

	function push(text: string) {
		// Tone is computed once here rather than in the template, where it would
		// re-run for every visible line on every re-render.
		lines.push({ id: nextId++, text, tone: toneOf(text) });
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
		nextId = 0;
		connect();
		return () => {
			source?.close();
			source = null;
			void id;
		};
	});

	$effect(() => {
		// Touch the length so this reruns on every appended line.
		lines.length;
		if (autoscroll && viewport) {
			viewport.scrollTop = viewport.scrollHeight;
		}
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
		history.unshift(text);
		historyIndex = -1;
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

	async function copyAll() {
		const text = lines.map((l) => l.text).join('\n');
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

	/** Minecraft log lines start with a level in brackets; colour on that alone. */
	function toneOf(text: string): string {
		if (/\/(ERROR|FATAL)\]/.test(text) || /\bException\b/.test(text)) return 'error';
		if (/\/WARN\]/.test(text)) return 'warn';
		if (text.startsWith('[rcon]')) return 'rcon';
		if (text.startsWith('[mineshell]') || text.startsWith('[journal]')) return 'meta';
		return '';
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
			<button class="button-quiet" onclick={copyAll} disabled={lines.length === 0}>
				{copied ? 'Copied' : 'Copy'}
			</button>
			<button class="button-quiet" onclick={() => (lines = [])}>Clear view</button>
		</span>
	</div>

	{#if error}
		<p class="notice warning small">{error}</p>
	{/if}

	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<!-- tabindex is deliberate: a scrollable region must be reachable by keyboard. -->
	<div class="viewport" bind:this={viewport} onscroll={onScroll} tabindex="0" role="log">
		{#if lines.length === 0}
			<p class="faint">Waiting for output. Nothing is logged while the server is stopped.</p>
		{:else}
			{#each lines as line (line.id)}
				<div class="line" data-tone={line.tone}>{line.text}</div>
			{/each}
		{/if}
	</div>

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
			placeholder={canSend ? 'Type a server command, e.g. say hello' : 'Start the server to send commands'}
			bind:value={command}
			onkeydown={onKeydown}
			disabled={!canSend || sending}
			autocomplete="off"
			spellcheck="false"
			aria-label="Server command"
		/>
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
</style>
