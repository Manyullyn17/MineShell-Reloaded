/**
 * A whole number from a form field, or `fallback` when the form does not
 * have the field or leaves it empty. Number(null) and Number('') are 0: a
 * section posting without a field (the server Settings' Game port section
 * has no RCON port) saved 0 for it.
 */
export function formInt(form: FormData, key: string, fallback: number): number {
	const raw = form.get(key);
	if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? Math.round(value) : fallback;
}

/**
 * "<fileName>\n<versionId>" pairs from repeated `key` fields (the update
 * reviews' checkboxes). Browsers send a newline in a form value as CRLF, so
 * split on that too: splitting on \n alone left "\r" on the file name and
 * every update from the Mods tab was refused.
 */
export function fileVersionPairs(form: FormData, key = 'change'): { fileName: string; versionId: string }[] {
	return form
		.getAll(key)
		.map(String)
		.map((v) => v.split(/\r?\n/))
		.filter((p) => p.length === 2 && p[0] && p[1])
		.map(([fileName, versionId]) => ({ fileName, versionId }));
}
