import { eq } from 'drizzle-orm';
import { db } from './db';
import { modUpdateNotices, settings } from './db/schema';

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

// ------------------------------------------------------------- data packs ---

/**
 * The same for data packs from the mod browser (instance_datapacks), on every
 * server that has some: they are the user's own, a pack's never. One settings
 * row per server, as the set is small and read only by the overview.
 */
const DATAPACK_KEY = (instanceId: string) => `datapacks.notice:${instanceId}`;

type DatapackNoticeRow = { updates: ModNoticeEntry[]; fingerprint: string; foundAt: number; skipped: boolean };

function readDatapackRow(instanceId: string): DatapackNoticeRow | null {
	const row = db.select().from(settings).where(eq(settings.key, DATAPACK_KEY(instanceId))).get();
	if (!row) return null;
	try {
		return JSON.parse(row.value) as DatapackNoticeRow;
	} catch {
		return null;
	}
}

function writeDatapackRow(instanceId: string, value: DatapackNoticeRow): void {
	const json = JSON.stringify(value);
	db.insert(settings).values({ key: DATAPACK_KEY(instanceId), value: json }).onConflictDoUpdate({ target: settings.key, set: { value: json } }).run();
}

/** As saveModNotice: true for a set not seen before. */
export function saveDatapackNotice(instanceId: string, updates: ModNoticeEntry[], now = Date.now()): boolean {
	if (!updates.length) {
		clearDatapackNotice(instanceId);
		return false;
	}
	const fingerprint = fingerprintOf(updates);
	const existing = readDatapackRow(instanceId);
	if (existing?.fingerprint === fingerprint) {
		writeDatapackRow(instanceId, { ...existing, updates });
		return false;
	}
	writeDatapackRow(instanceId, { updates, fingerprint, foundAt: now, skipped: false });
	return true;
}

export function currentDatapackNotice(instanceId: string): { updates: ModNoticeEntry[]; fingerprint: string; foundAt: number } | null {
	const row = readDatapackRow(instanceId);
	return row && !row.skipped && Array.isArray(row.updates) ? { updates: row.updates, fingerprint: row.fingerprint, foundAt: row.foundAt } : null;
}

export function skipDatapackNotice(instanceId: string, fingerprint: string): boolean {
	const row = readDatapackRow(instanceId);
	if (!row || row.fingerprint !== fingerprint) return false;
	writeDatapackRow(instanceId, { ...row, skipped: true });
	return true;
}

export function clearDatapackNotice(instanceId: string): void {
	db.delete(settings).where(eq(settings.key, DATAPACK_KEY(instanceId))).run();
}
