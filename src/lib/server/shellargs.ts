/**
 * JVM and launch arguments as typed in Settings, split the way a shell would, and written for
 * the unit's start line (unit-template.js), which hands them to `eval` (ARCHITECTURE,
 * "Quoting"). Before, the line split them on spaces only, so a quote reached Java as part of
 * the value: `-Dx="a b"` was two broken arguments.
 */

/**
 * The arguments in `text`, split on whitespace outside quotes. 'single quotes' keep everything
 * as it is; "double quotes" keep everything but a backslash before " or \; outside quotes a
 * backslash keeps the next character. Throws on a quote left open.
 */
export function splitArgs(text: string): string[] {
	const words: string[] = [];
	let word = '';
	let inWord = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (/\s/.test(c)) {
			if (inWord) words.push(word);
			word = '';
			inWord = false;
		} else if (c === "'") {
			const end = text.indexOf("'", i + 1);
			if (end === -1) throw new Error('A single quote is not closed.');
			word += text.slice(i + 1, end);
			inWord = true;
			i = end;
		} else if (c === '"') {
			inWord = true;
			for (i++; ; i++) {
				if (i >= text.length) throw new Error('A double quote is not closed.');
				if (text[i] === '"') break;
				if (text[i] === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) i++;
				word += text[i];
			}
		} else if (c === '\\' && i + 1 < text.length) {
			word += text[++i];
			inWord = true;
		} else {
			word += c;
			inWord = true;
		}
	}
	if (inWord) words.push(word);
	return words;
}

/**
 * `splitArgs`, or for a value saved with a quote left open (saving refuses one, but not every
 * value was saved through that check) split on spaces as the start line used to: the server
 * then starts as it always did instead of not at all.
 */
export function argsForUnit(text: string): string[] {
	try {
		return splitArgs(text);
	} catch {
		return text.split(/\s+/).filter(Boolean);
	}
}

/** One argument in single quotes, for a POSIX shell: nothing inside is read as anything. */
export function shellQuote(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The value of MS_JVM_ARGS or MS_LAUNCH_ARGS in `<id>.env`: each argument shell-quoted for the
 * start line's `eval`, all of it in double quotes so systemd passes the single quotes on (it
 * takes quotes in an environment file as its own), with the backslash and double quote it
 * reads as escapes inside them escaped.
 */
export function unitEnvArgs(text: string): string {
	const words = argsForUnit(text).map(shellQuote).join(' ');
	return `"${words.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}
