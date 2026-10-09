import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db } from './db';
import { playerSessions, settings, type ServerInstance } from './db/schema';
import { beginOperation, endOperation, listOperations } from './operations';
import { audit, getInstance, onlinePlayers, rconPassword, setStatus, start, stop } from './instances';
import { runFinishedStarting } from './journal';
import { getCountdown } from './countdown';
import { rconExec } from './rcon';
import { unitState } from './systemd';
import { startTask, type TaskHandle } from './tasks';
import { getSnapshotPolicy, listSnapshots, pruneSnapshots, takeSnapshot, worldFolders } from './snapshots';
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
 *
 * "Every N hours" falls on the clock: multiples of N from midnight (every
 * hour at :00). A slot nobody played in since the last full snapshot is
 * skipped unless turned off (`skipIdle`, on by default: the user's call). A
 * slot that comes while the server is stopping, starting, about to restart or
 * not done loading waits for it (at most WAIT_MAX_MS); a scheduled restart in
 * turn waits for a snapshot under way (scheduler.ts).
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
	/** Skip a slot when nobody was online since the last full snapshot. */
	skipIdle: boolean;
};

export const DEFAULT_SCHEDULE: SnapshotSchedule = { every: 'off', dailyTime: '04:00', intervalHours: 24, whileRunning: 'live', warnMinutes: 5, skipIdle: true };

/** How long a due slot waits for the server to be ready before it is let go. */
const WAIT_MAX_MS = 30 * 60_000;

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
		warnMinutes: Number.isInteger(warn) && warn >= 0 && warn <= 15 ? warn : DEFAULT_SCHEDULE.warnMinutes,
		skipIdle: raw.skipIdle !== false
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

export function nextSnapshotAt(schedule: Pick<SnapshotSchedule, 'every' | 'intervalHours' | 'dailyTime'>, from = Date.now()): number | null {
	if (schedule.every === 'interval') return clockSlot(schedule.intervalHours, from);
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

/**
 * The next slot after `from` for "every N hours", on the clock: up to a day,
 * the hours of each day that are multiples of N (every 5: 0, 5, 10, 15, 20,
 * then 0 again); whole days, every N/24 days at midnight, counted from a
 * fixed day; anything else, N hours on.
 */
export function clockSlot(hours: number, from: number): number {
	const next = new Date(from);
	next.setMinutes(0, 0, 0);
	if (hours <= 24) {
		for (let i = 0; i <= 48; i++, next.setHours(next.getHours() + 1)) {
			if (next.getTime() > from && next.getHours() % hours === 0) return next.getTime();
		}
	} else if (hours % 24 === 0) {
		next.setHours(0);
		for (let i = 0; i <= hours / 24 + 1; i++, next.setDate(next.getDate() + 1)) {
			const day = Math.round(Date.UTC(next.getFullYear(), next.getMonth(), next.getDate()) / 86_400_000);
			if (next.getTime() > from && day % (hours / 24) === 0) return next.getTime();
		}
	}
	return from + hours * 3_600_000;
}

/**
 * At MineShell's start, every server's next slot is worked out again: slots
 * that passed while it was down are not fired at once, and slots set before
 * "every N hours" fell on the clock move onto it.
 */
export function rollForwardSnapshots(now = Date.now()): void {
	for (const row of db.select().from(settings).all()) {
		if (!row.key.startsWith('snapshots.next:')) continue;
		const id = row.key.slice('snapshots.next:'.length);
		write(row.key, String(nextSnapshotAt(getSnapshotSchedule(id), now) ?? ''));
	}
}

export function scheduledSnapshotAt(instanceId: string): number | null {
	return Number(read(NEXT(instanceId))) || null;
}

export function describeSnapshotSchedule(schedule: SnapshotSchedule): string {
	if (schedule.every === 'off') return 'Off';
	const when =
		schedule.every === 'daily'
			? `Daily at ${schedule.dailyTime}`
			: schedule.intervalHours === 1
				? 'Every hour, on the hour'
				: `Every ${schedule.intervalHours} hours${schedule.intervalHours <= 24 || schedule.intervalHours % 24 === 0 ? ', from midnight' : ''}`;
	return `${when}, ${schedule.whileRunning === 'live' ? 'while running' : 'stopping the server'}`;
}

// ------------------------------------------------------------- running ---

/** Warning marks already sent for the coming snapshot, per server. */
const warned = new Map<string, Set<number>>();
/** Since when a due slot has been waiting for the server to be ready, per server. */
const waitingSince = new Map<string, number>();
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
	const notReady = await waitReason(instance, state.active, now);
	if (notReady) {
		const since = waitingSince.get(instance.id) ?? now;
		waitingSince.set(instance.id, since);
		if (now - since < WAIT_MAX_MS) return null;
		audit('scheduler.snapshot_skipped', { instanceId: instance.id, detail: `waited ${WAIT_MAX_MS / 60_000} minutes: ${notReady}`, actor: 'scheduler' });
		return moveOn(instance, schedule, now);
	}
	if (listOperations().some((o) => o.instanceId === instance.id)) {
		audit('scheduler.snapshot_skipped', { instanceId: instance.id, detail: 'another operation was running', actor: 'scheduler' });
		return moveOn(instance, schedule, now);
	}
	if (!(await worldFolders(instance.path)).length) return moveOn(instance, schedule, now);
	if (schedule.skipIdle && !(await playedSinceLastSnapshot(instance, active))) {
		audit('scheduler.snapshot_skipped', { instanceId: instance.id, detail: 'nobody was online since the last snapshot', actor: 'scheduler' });
		return moveOn(instance, schedule, now);
	}
	moveOn(instance, schedule, now);
	const mode = !active ? 'stopped' : schedule.whileRunning;
	return scheduledSnapshot(instance, mode);
}

function moveOn(instance: ServerInstance, schedule: SnapshotSchedule, now: number): null {
	write(NEXT(instance.id), String(nextSnapshotAt(schedule, now)));
	warned.delete(instance.id);
	waitingSince.delete(instance.id);
	return null;
}

/**
 * Why a due slot should wait, or null: the server is stopping or starting, a
 * restart is coming within its warning time (or a countdown runs), or it has
 * not finished loading - copying then would catch the world mid-write, or the
 * live copy's save-off would not be answered.
 */
async function waitReason(instance: ServerInstance, activeState: string, now: number): Promise<string | null> {
	if (activeState === 'activating' || activeState === 'deactivating' || activeState === 'reloading') return 'the server was starting or stopping';
	if (activeState !== 'active') return null;
	if (getCountdown(instance.id)) return 'a stop or restart countdown was running';
	const restartAt = instance.restartSchedule !== 'none' ? instance.restartNextAt : null;
	if (restartAt && restartAt - now <= Math.max(instance.restartWarnMinutes ?? 0, 1) * 60_000) return 'a scheduled restart was due';
	if (!(await runFinishedStarting(instance.id, instance.createdAt).catch(() => true))) return 'the server had not finished starting';
	return null;
}

/**
 * Whether anyone was online since the newest full snapshot (any kind: one
 * taken before a pack change counts): the player sessions MineShell reads
 * from the log, and who is online now. No snapshot yet counts as played.
 */
async function playedSinceLastSnapshot(instance: ServerInstance, active: boolean): Promise<boolean> {
	const last = Math.max(0, ...(await listSnapshots(instance.path)).filter((s) => !s.partial).map((s) => s.createdAt));
	if (!last) return true;
	const session = db
		.select()
		.from(playerSessions)
		.where(and(eq(playerSessions.instanceId, instance.id), or(isNull(playerSessions.leftAt), gt(playerSessions.leftAt, last))))
		.get();
	if (session) return true;
	if (!active) return false;
	const players = await onlinePlayers(instance).catch(() => null);
	return !!players && players.online > 0;
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
	// Which run of the server saving is paused in: one started since saves as usual.
	const run = (await unitState(instance.id, { fresh: true }).catch(() => null))?.activeEnterTimestamp ?? null;
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
			const now = await unitState(instance.id, { fresh: true }).catch(() => null);
			if (now?.active === 'active' && now.activeEnterTimestamp === run) {
				setStatus(instance.id, 'ready', 'Saving was paused for a scheduled snapshot and could not be turned back on. Run "save-on" in the console.');
				task.log('Could not turn saving back on: run "save-on" in the console.');
			} else {
				// Stopped or started again meanwhile: a server always starts with saving on.
				task.log('The server stopped or restarted during the copy; it saves as usual again.');
			}
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
