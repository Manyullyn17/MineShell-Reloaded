import { eq } from 'drizzle-orm';
import { db } from './db';
import { modUpdateNotices } from './db/schema';

/**
 * Mod updates the periodic check found on a server without a pack
 * (updatecheck.ts), shown on its overview until applied, skipped or no longer
 * found. Only enabled mods count: a disabled one is off for a reason, and the
 * review starts it unticked anyway.
 */

export type ModNoticeEntry = { fileName: string; name: string; from: string | null; to: string };

export function fingerprintOf(updates: ModNoticeEntry[]): string {
	return updates
		.map((u) => `${u.fileName}>${u.to}`)
		.sort()
		.join('\n');
}

/**
 * Keeps what a check found. True when it is a set not seen before (worth a
 * notification); the same set again keeps its skipped flag, and none found
 * removes the row.
 */
export function saveModNotice(instanceId: string, updates: ModNoticeEntry[], now = Date.now()): boolean {
	if (!updates.length) {
		clearModNotice(instanceId);
		return false;
	}
	const fingerprint = fingerprintOf(updates);
	const existing = db.select().from(modUpdateNotices).where(eq(modUpdateNotices.instanceId, instanceId)).get();
	if (existing?.fingerprint === fingerprint) {
		db.update(modUpdateNotices).set({ updates: JSON.stringify(updates) }).where(eq(modUpdateNotices.instanceId, instanceId)).run();
		return false;
	}
	const row = { instanceId, updates: JSON.stringify(updates), fingerprint, foundAt: now, skipped: false };
	db.insert(modUpdateNotices).values(row).onConflictDoUpdate({ target: modUpdateNotices.instanceId, set: row }).run();
	return true;
}

/** The updates to show, or null when there are none or they were skipped. */
export function currentModNotice(instanceId: string): { updates: ModNoticeEntry[]; fingerprint: string; foundAt: number } | null {
	const row = db.select().from(modUpdateNotices).where(eq(modUpdateNotices.instanceId, instanceId)).get();
	if (!row || row.skipped) return null;
	try {
		return { updates: JSON.parse(row.updates) as ModNoticeEntry[], fingerprint: row.fingerprint, foundAt: row.foundAt };
	} catch {
		return null;
	}
}

/** Hides this set; a check that finds a different one shows again. */
export function skipModNotice(instanceId: string, fingerprint: string): boolean {
	const row = db.select().from(modUpdateNotices).where(eq(modUpdateNotices.instanceId, instanceId)).get();
	if (!row || row.fingerprint !== fingerprint) return false;
	db.update(modUpdateNotices).set({ skipped: true }).where(eq(modUpdateNotices.instanceId, instanceId)).run();
	return true;
}

/**
 * Takes one mod out of the set (held at its version), keeping whether the rest
 * was skipped: the next check would leave it out anyway.
 */
export function dropFromModNotice(instanceId: string, fileName: string): void {
	const row = db.select().from(modUpdateNotices).where(eq(modUpdateNotices.instanceId, instanceId)).get();
	if (!row) return;
	let updates: ModNoticeEntry[];
	try {
		updates = (JSON.parse(row.updates) as ModNoticeEntry[]).filter((u) => u.fileName !== fileName);
	} catch {
		return;
	}
	if (!updates.length) return clearModNotice(instanceId);
	db.update(modUpdateNotices)
		.set({ updates: JSON.stringify(updates), fingerprint: fingerprintOf(updates) })
		.where(eq(modUpdateNotices.instanceId, instanceId))
		.run();
}

export function clearModNotice(instanceId: string): void {
	db.delete(modUpdateNotices).where(eq(modUpdateNotices.instanceId, instanceId)).run();
}
