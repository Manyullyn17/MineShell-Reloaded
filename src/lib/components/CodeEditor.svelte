<script lang="ts">
	import { onMount } from 'svelte';
	import { fitToViewport } from '#lib/shared/fitToViewport.js';
	import { languageOf, syntaxProblem, type SyntaxProblem } from '#lib/shared/syntaxcheck.js';
	import type { CodeEditorHandle } from '#lib/shared/codemirror.js';

	/**
	 * A text file's editor: line numbers, colours by file type and its syntax
	 * marked as you type (codemirror.ts, loaded when this mounts). The textarea
	 * under it is what the form posts; it is the editor itself until CodeMirror
	 * has loaded, and if it cannot be.
	 */
	let {
		name,
		value,
		fileName,
		line = null,
		find = null,
		problem = $bindable(null),
		checks = $bindable(false)
	}: {
		name: string;
		/** The text it opens with; later changes to it are not taken in (a save keeps the cursor where it is). */
		value: string;
		fileName: string;
		/** The line to open at, from 1. */
		line?: number | null;
		/** Text to select on that line. */
		find?: string | null;
		/** The first syntax error, as of the last check. */
		problem?: SyntaxProblem | null;
		/** Whether this file is checked: its kind has a check, and it parsed when it was opened. */
		checks?: boolean;
	} = $props();

	// svelte-ignore state_referenced_locally
	const language = languageOf(fileName);
	let host = $state<HTMLDivElement | null>(null);
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let editor = $state<CodeEditorHandle | null>(null);

	/** The current text: the editor's, or the textarea's before it loaded. */
	export function text(): string {
		return editor?.text() ?? textarea?.value ?? '';
	}

	export function goToLine(number: number): void {
		if (editor) return editor.goToLine(number);
		if (!textarea) return;
		const lines = textarea.value.split('\n');
		const at = lines.slice(0, Math.max(number - 1, 0)).reduce((sum, l) => sum + l.length + 1, 0);
		textarea.focus();
		textarea.setSelectionRange(at, at);
	}

	onMount(() => {
		let destroyed = false;
		(async () => {
			// svelte-ignore state_referenced_locally
			const initial = value;
			checks = language !== null && !(await syntaxProblem(language, initial));
			const { createEditor } = await import('#lib/shared/codemirror.js');
			if (destroyed || !host) return;
			editor = await createEditor(host, {
				text: textarea?.value ?? initial,
				language,
				check: checks,
				line,
				find,
				onChange: (text) => {
					if (textarea) textarea.value = text;
				},
				onProblem: (found) => (problem = found)
			});
			if (destroyed) editor.destroy();
		})().catch((err) => console.warn('[mineshell] the editor did not load; the plain one stays.', err));
		return () => {
			destroyed = true;
			editor?.destroy();
		};
	});
</script>

<div class="code-editor" bind:this={host} use:fitToViewport={{ bottomMarginPx: 96 }}></div>
<textarea
	bind:this={textarea}
	{name}
	rows="26"
	spellcheck="false"
	class="plain-editor"
	class:loaded={!!editor}
	aria-hidden={editor ? 'true' : undefined}
	tabindex={editor ? -1 : undefined}>{value}</textarea
>

<style>
	.code-editor {
		display: flex;
		flex-direction: column;
		min-height: 16rem;
	}

	.code-editor:empty {
		display: none;
	}

	.code-editor :global(.cm-editor) {
		flex: 1 1 auto;
		min-height: 16rem;
	}

	.plain-editor {
		font-family: var(--font-mono);
		font-size: 0.8rem;
		line-height: 1.5;
		white-space: pre;
		overflow-wrap: normal;
		overflow-x: auto;
	}

	/* Still posted with the form, out of sight. */
	.plain-editor.loaded {
		display: none;
	}
</style>
