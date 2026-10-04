import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings } from './db/schema';

/**
 * Saved console commands, per server, kept with MineShell rather than in the
 * browser so they are there on every device. One settings row per server.
 */

export const MAX_MACROS = 20;
export const MAX_MACRO_LENGTH = 200;

const key = (instanceId: string) => `console.macros:${instanceId}`;

/** Every read is validated, so a hand-edited row degrades to what still makes sense. */
function clean(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (typeof item !== 'string') continue;
		const command = item.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_MACRO_LENGTH);
		if (command) seen.add(command);
	}
	return [...seen].slice(0, MAX_MACROS);
}

export function getMacros(instanceId: string): string[] {
	const row = db.select().from(settings).where(eq(settings.key, key(instanceId))).get();
	try {
		return clean(row ? JSON.parse(row.value) : []);
	} catch {
		return [];
	}
}

export function setMacros(instanceId: string, macros: unknown): string[] {
	const valid = clean(macros);
	const value = JSON.stringify(valid);
	db.insert(settings)
		.values({ key: key(instanceId), value })
		.onConflictDoUpdate({ target: settings.key, set: { value } })
		.run();
	return valid;
}

export function deleteMacros(instanceId: string): void {
	db.delete(settings).where(eq(settings.key, key(instanceId))).run();
}
