/** Splits text around a search (any case) so the matches can be marked. */
export function segments(text: string, query: string): { text: string; hit: boolean }[] {
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
