import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings, type ServerInstance } from './db/schema';
import { beginOperation, endOperation, listOperations } from './operations';
import { audit, getInstance, rconPassword, setStatus, start, stop } from './instances';
import { rconExec } from './rcon';
import { unitState } from './systemd';
import { startTask, type TaskHandle } from './tasks';
import { getSnapshotPolicy, pruneSnapshots, takeSnapshot, worldFolders } from './snapshots';
import { formatBytes } from '#lib/shared/format.js';

/**
 * World snapshots on a schedule ("daily at 4:00", "every 12 hours"), kept by
 * the same retention policy as the others. A stopped server is copied as it
 * is. A running one either:
 * - live (default): saving paused (save-off, save-all flush), the world's
 *   files left to go quiet, copied, saving turned back on however the copy
 *   ends. Players keep playing; the world just is not saved meanwhile.
 * - stop: warned like a scheduled restart, stopped, copied, started again as
 *   soon as the copy is done - also when it failed.
 * Both are journalled (`scheduled-snapshot`): if MineShell dies in the
 * middle, recovery turns saving back on, or starts the server it stopped.
 */

export type SnapshotSchedule = {
	every: 'off' | 'daily' | 'interval';
	/** HH:MM, local time, for 'daily'. */
	dailyTime: string;
	/** For 'interval'. */
	intervalHours: number;
	/** What happens to a running server. */
	whileRunning: 'live' | 'stop';
	/** Warnings before a stop (stop mode), in minutes; 0 for none. */
	warnMinutes: number;
};

export const DEFAULT_SCHEDULE: SnapshotSchedule = { every: 'off', dailyTime: '04:00', intervalHours: 24, whileRunning: 'live', warnMinutes: 5 };

const KEY = (id: string) => `snapshots.schedule:${id}`;
const NEXT = (id: string) => `snapshots.next:${id}`;

/** Timings tests shorten. */
export const scheduleTiming = { pollMs: 3000, quietMs: 5000, quietMaxMs: 120_000 };

function read(key: string): string | null {
	return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

function write(key: string, value: string | null): void {
	if (value === null) db.delete(settings).where(eq(settings.key, key)).run();
	else db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

export function getSnapshotSchedule(instanceId: string): SnapshotSchedule {
	try {
		return validSchedule(JSON.parse(read(KEY(instanceId)) ?? '{}'));
	} catch {
		return DEFAULT_SCHEDULE;
	}
}

/** Anything stored or sent, made into a schedule: unknown or out-of-range values fall back. */
export function validSchedule(raw: Record<string, unknown>): SnapshotSchedule {
	const time = typeof raw.dailyTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.dailyTime) ? raw.dailyTime : DEFAULT_SCHEDULE.dailyTime;
	const hours = Number(raw.intervalHours);
	const warn = Number(raw.warnMinutes);
	return {
		every: raw.every === 'daily' || raw.every === 'interval' ? raw.every : 'off',
		dailyTime: time,
		intervalHours: Number.isInteger(hours) && hours >= 1 && hours <= 24 * 7 ? hours : DEFAULT_SCHEDULE.intervalHours,
		whileRunning: raw.whileRunning === 'stop' ? 'stop' : 'live',
		warnMinutes: Number.isInteger(warn) && warn >= 0 && warn <= 15 ? warn : DEFAULT_SCHEDULE.warnMinutes
	};
}

export function saveSnapshotSchedule(instanceId: string, schedule: SnapshotSchedule): void {
	write(KEY(instanceId), JSON.stringify(schedule));
	write(NEXT(instanceId), schedule.every === 'off' ? null : String(nextSnapshotAt(schedule)));
	warned.delete(instanceId);
}

export function deleteSnapshotSchedule(instanceId: string): void {
	write(KEY(instanceId), null);
	write(NEXT(instanceId), null);
}

export function copySnapshotSchedule(fromId: string, toId: string): void {
	const raw = read(KEY(fromId));
	if (raw) saveSnapshotSchedule(toId, getSnapshotSchedule(fromId));
}

export function nextSnapshotAt(schedule: SnapshotSchedule, from = Date.now()): number | null {
	if (schedule.every === 'interval') return from + schedule.intervalHours * 3_600_000;
	if (schedule.every === 'daily') {
		const [hour, minute] = schedule.dailyTime.split(':').map(Number);
		const next = new Date(from);
		next.setSeconds(0, 0);
		next.setHours(hour, minute);
		if (next.getTime() <= from) next.setDate(next.getDate() + 1);
		return next.getTime();
	}
	return null;
}

/** At MineShell's start: slots that passed while it was down move to the next one, not fired at once. */
export function rollForwardSnapshots(now = Date.now()): void {
	for (const row of db.select().from(settings).all()) {
		if (!row.key.startsWith('snapshots.next:')) continue;
		const id = row.key.slice('snapshots.next:'.length);
		if (Number(row.value) < now) write(row.key, String(nextSnapshotAt(getSnapshotSchedule(id), now) ?? ''));
	}
}

export function scheduledSnapshotAt(instanceId: string): number | null {
	return Number(read(NEXT(instanceId))) || null;
}

export function describeSnapshotSchedule(schedule: SnapshotSchedule): string {
	if (schedule.every === 'off') return 'Off';
	const when = schedule.every === 'daily' ? `Daily at ${schedule.dailyTime}` : `Every ${schedule.intervalHours} hour${schedule.intervalHours === 1 ? '' : 's'}`;
	return `${when}, ${schedule.whileRunning === 'live' ? 'while running' : 'stopping the server'}`;
}

// ------------------------------------------------------------- running ---

/** Warning marks already sent for the coming snapshot, per server. */
const warned = new Map<string, Set<number>>();
/** Servers whose scheduled snapshot is under way. */
const running = new Set<string>();

/**
 * One scheduler tick for one server: in-game warnings (stop mode), then the
 * snapshot when due. A slot missed while MineShell was down is not caught
 * up: the next one is set, like scheduled restarts.
 */
export async function evaluateSnapshotSchedule(instance: ServerInstance, now = Date.now()): Promise<string | null> {
	const schedule = getSnapshotSchedule(instance.id);
	if (schedule.every === 'off' || running.has(instance.id)) return null;
	const nextAt = scheduledSnapshotAt(instance.id);
	if (!nextAt) {
		write(NEXT(instance.id), String(nextSnapshotAt(schedule, now)));
		return null;
	}
	const state = await unitState(instance.id);
	const active = state.active === 'active';
	if (active && schedule.whileRunning === 'stop' && schedule.warnMinutes > 0 && nextAt > now) {
		const msUntil = nextAt - now;
		const sent = warned.get(instance.id) ?? new Set<number>();
		for (const mark of [15, 10, 5, 1].filter((m) => m <= schedule.warnMinutes)) {
			if (msUntil <= mark * 60_000 && !sent.has(mark)) {
				sent.add(mark);
				warned.set(instance.id, sent);
				await say(instance, `The server stops for a world backup in ${mark} minute${mark === 1 ? '' : 's'}; back right after.`);
			}
		}
	}
	if (nextAt > now) return null;
	write(NEXT(instance.id), String(nextSnapshotAt(schedule, now)));
	warned.delete(instance.id);
	if (listOperations().some((o) => o.instanceId === instance.id)) {
		audit('scheduler.snapshot_skipped', { instanceId: instance.id, detail: 'another operation was running', actor: 'scheduler' });
		return null;
	}
	if (!(await worldFolders(instance.path)).length) return null;
	const mode = !active ? 'stopped' : schedule.whileRunning;
	return scheduledSnapshot(instance, mode);
}

async function say(instance: ServerInstance, text: string): Promise<void> {
	const password = rconPassword(instance);
	if (!password) return;
	await rconExec({ port: instance.rconPort, password }, [`say ${text}`]).catch(() => undefined);
}

/** Starts the snapshot as a task (shown in the notification center); returns its id. */
export function scheduledSnapshot(instance: ServerInstance, mode: 'stopped' | 'live' | 'stop'): string {
	beginOperation(instance.id, { kind: 'scheduled-snapshot', mode, restart: mode === 'stop' });
	running.add(instance.id);
	audit('scheduler.snapshot', { instanceId: instance.id, detail: mode, actor: 'scheduler' });
	return startTask({ label: `Scheduled snapshot of ${instance.name}`, instanceId: instance.id }, async (task) => {
		try {
			if (mode === 'live') await liveSnapshot(instance, task);
			else if (mode === 'stop') await stoppingSnapshot(instance, task);
			else await copy(instance, task, 'Scheduled, server stopped');
		} finally {
			endOperation(instance.id);
			running.delete(instance.id);
		}
		task.setProgress(100, 'Done');
	});
}

async function copy(instance: ServerInstance, task: TaskHandle, label: string): Promise<void> {
	task.setProgress(null, 'Copying the world');
	const snapshot = await takeSnapshot(instance, { reason: 'scheduled', label });
	if (!snapshot) {
		task.log('No world yet; nothing to snapshot.');
		return;
	}
	task.log(`Snapshotted ${snapshot.worlds.join(', ')} (${formatBytes(snapshot.sizeBytes)}) as ${snapshot.id}.`);
	const removed = await pruneSnapshots(instance.path, getSnapshotPolicy(instance.id));
	if (removed.length) task.log(`Deleted older snapshot${removed.length === 1 ? '' : 's'}: ${removed.join(', ')}.`);
}

async function liveSnapshot(instance: ServerInstance, task: TaskHandle): Promise<void> {
	const password = rconPassword(instance);
	if (!password) throw new Error('RCON is not set up for this server, so saving cannot be paused for a copy while it runs.');
	const rcon = (commands: string[]) => rconExec({ port: instance.rconPort, password }, commands);
	task.setProgress(null, 'Pausing saving');
	try {
		await rcon(['save-off', 'save-all flush']);
	} catch {
		// save-off may have got through before the failure.
		await rcon(['save-on']).catch(() => undefined);
		throw new Error('The server did not answer over RCON, so saving could not be paused; no snapshot was taken.');
	}
	try {
		task.log('Saving paused (save-off, save-all flush).');
		// Old Forge writes chunks on a thread of its own after save-all answers; mods can write late too.
		task.setProgress(null, 'Waiting for the world files to settle');
		const settled = await waitForQuiet(instance.path, await worldFolders(instance.path));
		if (!settled) task.log(`Files were still being written after ${scheduleTiming.quietMaxMs / 1000} s; copying anyway.`);
		await copy(instance, task, 'Scheduled, while running');
	} finally {
		try {
			await rcon(['save-on']);
			task.log('Saving turned back on (save-on).');
		} catch {
			setStatus(instance.id, 'ready', 'Saving was paused for a scheduled snapshot and could not be turned back on. Run "save-on" in the console.');
			task.log('Could not turn saving back on: run "save-on" in the console.');
		}
	}
}

async function stoppingSnapshot(instance: ServerInstance, task: TaskHandle): Promise<void> {
	task.setProgress(null, 'Stopping the server');
	await say(instance, 'The server stops now for a world backup; back in a moment.');
	await stop(instance, { internal: true });
	if (!(await waitStopped(instance.id, 6 * 60_000))) await stop(instance, { graceful: false, internal: true });
	if (!(await waitStopped(instance.id, 60_000))) throw new Error('The server did not stop, so no snapshot was taken.');
	// Not startable meanwhile: a start would copy a world being written.
	setStatus(instance.id, 'provisioning', 'Taking a scheduled snapshot; it starts again right after.');
	try {
		await copy(instance, task, 'Scheduled, server stopped for it');
	} finally {
		setStatus(instance.id, 'ready', null);
		task.setProgress(null, 'Starting the server again');
		const started = await start(getInstance(instance.id) ?? instance, { internal: true });
		task.log(started.ok ? 'Started the server again.' : `Starting it again failed: ${started.message}`);
	}
}

async function waitStopped(id: string, ms: number): Promise<boolean> {
	const until = Date.now() + ms;
	for (;;) {
		const s = await unitState(id, { fresh: true }).catch(() => null);
		if (!s || s.active === 'inactive' || s.active === 'failed') return true;
		if (Date.now() > until) return false;
		await new Promise((r) => setTimeout(r, scheduleTiming.pollMs));
	}
}

/** Until no file in the worlds changed for quietMs, at most quietMaxMs. */
export async function waitForQuiet(root: string, worlds: string[]): Promise<boolean> {
	const until = Date.now() + scheduleTiming.quietMaxMs;
	for (;;) {
		const newest = Math.max(0, ...(await Promise.all(worlds.map((w) => newestChange(path.join(root, w))))));
		if (Date.now() - newest >= scheduleTiming.quietMs) return true;
		if (Date.now() > until) return false;
		await new Promise((r) => setTimeout(r, Math.min(1000, scheduleTiming.quietMs)));
	}
}

async function newestChange(dir: string): Promise<number> {
	let newest = 0;
	for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
		if (!entry.isFile()) continue;
		const stat = await fs.stat(path.join(entry.parentPath, entry.name)).catch(() => null);
		if (stat && stat.mtimeMs > newest) newest = stat.mtimeMs;
	}
	return newest;
}

/** Recovery's part: saving back on, or the server started again. */
export async function recoverScheduledSnapshot(instance: ServerInstance, journal: { mode: string; restart: boolean }): Promise<void> {
	if (journal.mode === 'live') {
		const password = rconPassword(instance);
		const state = await unitState(instance.id, { fresh: true }).catch(() => null);
		if (password && state?.active === 'active') await rconExec({ port: instance.rconPort, password }, ['save-on']);
	}
}
