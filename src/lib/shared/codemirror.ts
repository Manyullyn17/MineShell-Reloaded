import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
	drawSelection,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { bracketMatching, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';
import { syntaxProblem, type EditorLanguage, type SyntaxProblem } from './syntaxcheck';

/**
 * The Files editor (CodeEditor.svelte imports this only when it opens, so
 * CodeMirror's size is loaded there alone). Colours come from the theme's own
 * variables, so every MineShell theme, light or dark, styles it.
 */

const theme = EditorView.theme({
	'&': {
		backgroundColor: 'var(--bg-sunken)',
		color: 'var(--text)',
		border: '1px solid var(--line)',
		borderRadius: 'var(--radius)',
		fontSize: '0.8rem',
		maxHeight: 'inherit'
	},
	'&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-1px' },
	'.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5', overflow: 'auto' },
	'.cm-content': { caretColor: 'var(--text)' },
	'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
	'.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--text-faint)', borderRight: '1px solid var(--line)' },
	'.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 5%, transparent)' },
	'.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--text) 8%, transparent)', color: 'var(--text-muted)' },
	'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
		backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)'
	},
	'.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 15%, transparent)' },
	'.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)', outline: 'none' },
	'.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warning) 30%, transparent)' },
	'.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--warning) 55%, transparent)' },
	'.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--line)' },
	'.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '0.8rem' },
	'.cm-tooltip': { backgroundColor: 'var(--panel-raised)', color: 'var(--text)', border: '1px solid var(--line)' },
	'.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--error)' }
});

const colours = HighlightStyle.define([
	{ tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--text-faint)', fontStyle: 'italic' },
	{ tag: [t.string, t.special(t.string)], color: 'var(--success)' },
	{ tag: [t.number, t.bool, t.atom, t.null], color: 'var(--warning)' },
	{ tag: [t.propertyName, t.definition(t.propertyName), t.attributeName], color: 'var(--info)' },
	{ tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.modifier], color: 'var(--accent)' },
	{ tag: [t.heading, t.meta, t.labelName, t.typeName, t.className], color: 'var(--accent)', fontWeight: '600' },
	{ tag: [t.variableName, t.definition(t.variableName)], color: 'var(--text)' },
	{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--info)' },
	{ tag: t.invalid, color: 'var(--error)' }
]);

/**
 * Forge 1.12's .cfg: `# comments`, `category {` and `}`, typed keys (`B:`, `I:`, `D:`, `S:`
 * and their `<` `>` lists), names quoted when they hold spaces.
 */
const forgeCfg = StreamLanguage.define<{ value: boolean }>({
	startState: () => ({ value: false }),
	token(stream, state) {
		if (stream.sol()) state.value = false;
		if (stream.eatSpace()) return null;
		if (stream.peek() === '#') {
			stream.skipToEnd();
			return 'comment';
		}
		if (state.value) {
			stream.skipToEnd();
			const text = stream.current().trim();
			return /^(true|false)$/.test(text) ? 'atom' : /^-?\d+(\.\d+)?$/.test(text) ? 'number' : 'string';
		}
		if (stream.match(/^[BIDS]:/)) return 'keyword';
		if (stream.match(/^"[^"]*"/) || stream.match(/^[^=<{}\s"]+/)) {
			const word = stream.current();
			if (stream.match(/^\s*\{/, false)) return 'heading';
			return /^"/.test(word) || !/^[{}<>]/.test(word) ? 'propertyName' : null;
		}
		if (stream.eat('=')) {
			state.value = true;
			return 'operator';
		}
		stream.next();
		return 'bracket';
	}
});

async function languageSupport(language: EditorLanguage): Promise<Extension> {
	switch (language) {
		case 'json':
		case 'json5':
			return (await import('@codemirror/lang-json')).json();
		case 'javascript':
			return (await import('@codemirror/lang-javascript')).javascript();
		case 'toml':
			return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml);
		case 'yaml':
			return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/yaml')).yaml);
		case 'forgecfg':
			return forgeCfg;
		case 'properties':
			return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/properties')).properties);
		case 'shell':
			return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell);
		default:
			return [];
	}
}

export type CodeEditorHandle = {
	view: EditorView;
	text: () => string;
	/** Puts the cursor on a line (from 1), on `find` in it when given, and scrolls it into the middle. */
	goToLine: (line: number, find?: string | null) => void;
	destroy: () => void;
};

export async function createEditor(
	parent: HTMLElement,
	opts: {
		text: string;
		language: EditorLanguage;
		/** Mark syntax errors as you type (only when the file parsed when it was opened). */
		check: boolean;
		line: number | null;
		/** Text to select on that line (what a search found). */
		find?: string | null;
		onChange: (text: string) => void;
		onProblem: (problem: SyntaxProblem | null) => void;
	}
): Promise<CodeEditorHandle> {
	const lint = opts.check
		? [
				linter(
					async (view): Promise<Diagnostic[]> => {
						const problem = await syntaxProblem(opts.language, view.state.doc.toString());
						opts.onProblem(problem);
						if (!problem) return [];
						const line = view.state.doc.line(Math.min(Math.max(problem.line, 1), view.state.doc.lines));
						return [{ from: line.from, to: line.to, severity: 'error', message: problem.message }];
					},
					{ delay: 500 }
				),
				lintGutter()
			]
		: [];
	const view = new EditorView({
		parent,
		state: EditorState.create({
			doc: opts.text,
			extensions: [
				lineNumbers(),
				highlightActiveLineGutter(),
				highlightSpecialChars(),
				history(),
				drawSelection(),
				indentOnInput(),
				bracketMatching(),
				highlightActiveLine(),
				highlightSelectionMatches(),
				keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
				await languageSupport(opts.language),
				syntaxHighlighting(colours),
				theme,
				lint,
				EditorView.updateListener.of((update) => {
					if (update.docChanged) opts.onChange(update.state.doc.toString());
				})
			]
		})
	});
	const goToLine = (number: number, find?: string | null) => {
		const line = view.state.doc.line(Math.min(Math.max(number, 1), view.state.doc.lines));
		const at = find ? line.text.toLowerCase().indexOf(find.toLowerCase()) : -1;
		const selection = at >= 0 ? EditorSelection.range(line.from + at, line.from + at + find!.length) : EditorSelection.cursor(line.from);
		view.dispatch({ selection, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
		view.focus();
	};
	if (opts.line) goToLine(opts.line, opts.find);
	return { view, text: () => view.state.doc.toString(), goToLine, destroy: () => view.destroy() };
}
