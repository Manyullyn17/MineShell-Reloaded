/**
 * What the Files editor colours a file as, and the check it runs before a
 * save: a broken JSON or TOML config saved silently and failed at the next
 * start. The parsers are imported when a file of their kind is checked, so
 * only the editor loads them.
 */

export type EditorLanguage = 'json' | 'json5' | 'toml' | 'yaml' | 'properties' | 'forgecfg' | 'javascript' | 'shell' | null;

export type SyntaxProblem = { line: number; message: string };

const BY_EXTENSION: Record<string, EditorLanguage> = {
	json: 'json',
	mcmeta: 'json',
	json5: 'json5',
	toml: 'toml',
	yaml: 'yaml',
	yml: 'yaml',
	properties: 'properties',
	// Forge 1.12's configs: `S:name=value` inside `category { }`.
	cfg: 'forgecfg',
	js: 'javascript',
	mjs: 'javascript',
	ts: 'javascript',
	sh: 'shell'
};

export function languageOf(fileName: string): EditorLanguage {
	const dot = fileName.lastIndexOf('.');
	return dot < 0 ? null : (BY_EXTENSION[fileName.slice(dot + 1).toLowerCase()] ?? null);
}

/** The line a character offset is on, counting from 1. */
function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < Math.min(offset, text.length); i++) if (text[i] === '\n') line++;
	return line;
}

/**
 * Each browser words JSON.parse's errors its own way. Chrome and Node: "Expected ',' or '}'
 * after property value in JSON at position 52 (line 4 column 3)"; Firefox: "JSON.parse:
 * expected ',' or '}' after property value in object at line 4 column 3 of the JSON data";
 * Safari names no place, so JSON5 (a superset, stopping at the same spot) finds the line.
 */
async function jsonProblem(text: string): Promise<SyntaxProblem | null> {
	try {
		JSON.parse(text);
		return null;
	} catch (err) {
		const raw = err instanceof Error ? err.message : String(err);
		const what = raw
			.replace(/^JSON\.parse: /, '')
			.replace(/\s+(in JSON|in object|in array|at line)\b.*$/, '')
			.replace(/^./, (c) => c.toUpperCase());
		const position = raw.match(/at position (\d+)/);
		const line = raw.match(/line (\d+) column/);
		if (position) return { line: lineAt(text, Number(position[1])), message: what };
		if (line) return { line: Number(line[1]), message: what };
		const { default: JSON5 } = await import('json5');
		try {
			JSON5.parse(text);
		} catch (e) {
			return { line: (e as { lineNumber?: number }).lineNumber ?? 1, message: what };
		}
		return { line: lineAt(text, text.length), message: what };
	}
}

/**
 * The first syntax error in `text`, or null: also null for a kind that has no
 * check (properties, scripts, plain text).
 */
export async function syntaxProblem(language: EditorLanguage, text: string): Promise<SyntaxProblem | null> {
	if (!text.trim()) return null;
	if (language === 'json') return await jsonProblem(text);
	if (language === 'json5') {
		const { default: JSON5 } = await import('json5');
		try {
			JSON5.parse(text);
			return null;
		} catch (err) {
			const e = err as Error & { lineNumber?: number };
			return { line: e.lineNumber ?? 1, message: e.message.replace(/^JSON5: /, '').replace(/ at \d+:\d+$/, '') };
		}
	}
	if (language === 'toml') {
		const { parse, TomlError } = await import('smol-toml');
		try {
			parse(text);
			return null;
		} catch (err) {
			if (err instanceof TomlError) return { line: err.line, message: err.message.split('\n')[0].replace(/^Invalid TOML document: /, '') };
			return { line: 1, message: err instanceof Error ? err.message : String(err) };
		}
	}
	if (language === 'yaml') {
		const { parseAllDocuments } = await import('yaml');
		for (const doc of parseAllDocuments(text, { prettyErrors: false })) {
			const err = 'errors' in doc ? doc.errors[0] : undefined;
			if (err) return { line: lineAt(text, err.pos[0]), message: err.message.split('\n')[0] };
		}
		return null;
	}
	return null;
}
