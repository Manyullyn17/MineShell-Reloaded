import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings } from './db/schema';
import { deleteOldLogs } from './diskusage';
import { formatBytes } from '#lib/shared/format.js';

/**
 * Archived logs (`logs/*.log.gz`) and crash reports kept this many days, then deleted by the
 * scheduler on every server; 0, the default, keeps them all, as MineShell always had.
 * Minecraft rotates latest.log into a new .log.gz
 * each start and never removes one, so a server restarted daily for a year has hundreds.
 */

const DAYS_KEY = 'logs.keepDays';
export const MAX_LOG_DAYS = 3650;
/** The folders are read at most this often per server: the scheduler checks every 30 s. */
const EVERY_MS = 60 * 60_000;

export function logKeepDays(): number {
	const raw = db.select().from(settings).where(eq(settings.key, DAYS_KEY)).get()?.value;
	const days = raw === undefined ? NaN : Number(raw);
	return Number.isInteger(days) && days >= 0 && days <= MAX_LOG_DAYS ? days : 0;
}

export function setLogKeepDays(days: number): void {
	if (!Number.isInteger(days) || days < 0 || days > MAX_LOG_DAYS) {
		throw new Error(`Keep logs 0 to ${MAX_LOG_DAYS} days (0 keeps them all).`);
	}
	const value = String(days);
	db.insert(settings).values({ key: DAYS_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

const globals = globalThis as { __mineshellLogsCheckedAt?: Map<string, number> };
const checkedAt = (globals.__mineshellLogsCheckedAt ??= new Map());

/** The scheduler's part: a server's archived logs and crash reports past the kept days go. */
export async function expireOldLogs(instanceId: string, root: string, now = Date.now()): Promise<number> {
	const days = logKeepDays();
	if (!days || now - (checkedAt.get(instanceId) ?? 0) < EVERY_MS) return 0;
	checkedAt.set(instanceId, now);
	const { files, bytes } = await deleteOldLogs(root, days, now);
	if (files) console.log(`[mineshell] deleted ${files} log${files === 1 ? '' : 's'} and crash reports older than ${days} days for ${instanceId} (${formatBytes(bytes)})`);
	return files;
}

/** For tests: forget when each server was last looked at. */
export function resetLogChecks(): void {
	checkedAt.clear();
}
