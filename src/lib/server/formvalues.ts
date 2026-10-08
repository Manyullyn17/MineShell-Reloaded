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
