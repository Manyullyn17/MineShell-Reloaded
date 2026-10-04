import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerInstance } from './db/schema';
import { indexMods } from './crashdiag';
import { rconPassword } from './instances';
import { subscribeConsole } from './journal';
import { modsDir } from './mods';
import { rconExec } from './rcon';
import { unitState } from './systemd';
import { cancelTask, startTask, type TaskHandle } from './tasks';

/**
 * Spark profiles, started from MineShell. Spark runs every command on its own
 * worker thread, so RCON returns before Spark has said anything, and a reply
 * meant only for the sender (`spark tps`) is lost. Two things do outlive that:
 * - broadcasts ("Profiler is now running!", the upload link) go to every
 *   sender with permission, the server console included, so they reach the
 *   journal;
 * - every upload is recorded in `config/spark/activity.json` (url or file,
 *   time, who), newest first, kept 60 days. That file is what tells a profile
 *   has finished, and it lists profiles started in-game too.
 *
 * Commands use the flag forms (`spark profiler --timeout 30`, `--stop`,
 * `--cancel`): Spark 1.5 for Forge 1.12.2 knows only those, and current Spark
 * still takes them besides its `start`/`stop`/`cancel` subcommands.
 */

export class SparkError extends Error {}

/** Spark refuses a timeout of 10 s or less. */
export const PROFILE_SECONDS = [30, 60, 120, 300, 600] as const;

export type SparkUpload = {
	time: number;
	/** Spark's label: "Profiler", "Health report", "Heap dump summary", ... */
	type: string;
	/** Who ran it: a player name, or the console's / RCON's name. */
	user: string;
	url: string | null;
	/** Set instead of url when Spark saved to disk (an upload failed, or --save-to-file). */
	file: string | null;
};

export function activityFile(root: string): string {
	return path.join(root, 'config', 'spark', 'activity.json');
}

/** Entries of activity.json, newest first. Links are only ever http(s). */
export function parseActivity(raw: string): SparkUpload[] {
	let entries: unknown;
	try {
		entries = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(entries)) return [];
	const uploads: SparkUpload[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== 'object') continue;
		const { time, type, user, data } = entry as Record<string, unknown>;
		if (typeof time !== 'number' || typeof type !== 'string' || !data || typeof data !== 'object') continue;
		const { type: kind, value } = data as Record<string, unknown>;
		if (typeof value !== 'string') continue;
		const url = kind === 'url' && /^https?:\/\//i.test(value) ? value : null;
		const file = kind === 'file' ? value : null;
		if (!url && !file) continue;
		const name = user && typeof user === 'object' ? (user as Record<string, unknown>).name : null;
		uploads.push({ time, type, user: typeof name === 'string' ? name : '', url, file });
	}
	return uploads.sort((a, b) => b.time - a.time);
}

export async function sparkUploads(root: string): Promise<SparkUpload[]> {
	const raw = await fs.readFile(activityFile(root), 'utf8').catch(() => '[]');
	return parseActivity(raw);
}

/**
 * Spark's broadcast when a profiler starts: "Starting a new profiler" / "Profiler
 * is now running!" now, "Initializing a new profiler" / "Profiler now active!"
 * in 1.5. Not just "profiler": 1.5 also says "An active profiler is already running."
 */
const STARTED = /new profiler|profiler is now running|profiler now active/i;

/** Old Spark builds called the profiler the sampler. */
const isProfile = (upload: SparkUpload) => /profil|sampl/i.test(upload.type);

/** Mods folder mtime -> installed; the overview asks on every poll. */
const installedCache = new Map<string, { mtimeMs: number; installed: boolean }>();

export async function hasSpark(root: string): Promise<boolean> {
	const dir = modsDir(root);
	const stat = await fs.stat(dir).catch(() => null);
	if (!stat) return false;
	const hit = installedCache.get(dir);
	if (hit && hit.mtimeMs === stat.mtimeMs) return hit.installed;
	const installed = (await indexMods(dir)).some((jar) => jar.enabled && jar.ids.includes('spark'));
	installedCache.set(dir, { mtimeMs: stat.mtimeMs, installed });
	return installed;
}

// ------------------------------------------------------------- profiling ---

export type ActiveProfile = { taskId: string; startedAt: number; endsAt: number };

/** In memory, like countdowns: a MineShell restart forgets it, Spark still finishes and uploads. */
const active = new Map<string, ActiveProfile>();

export function activeProfile(instanceId: string): ActiveProfile | null {
	return active.get(instanceId) ?? null;
}

export type ProfileTiming = {
	/** How often activity.json is read. */
	pollMs: number;
	/** How long to wait for Spark's "Profiler is now running!" in the console. */
	confirmMs: number;
	/** After the profile's end, how long the upload may take. */
	uploadGraceMs: number;
	/** How often to check the server is still running. */
	stateCheckMs: number;
};

const TIMING: ProfileTiming = { pollMs: 2000, confirmMs: 30_000, uploadGraceMs: 120_000, stateCheckMs: 10_000 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function rconTarget(instance: ServerInstance) {
	const password = rconPassword(instance);
	if (!password) throw new SparkError('RCON has no password for this server, so MineShell cannot talk to Spark.');
	return { port: instance.rconPort, password };
}

/**
 * Starts `spark profiler --timeout <seconds>` as a task; the task ends
 * when Spark has uploaded the result. Returns the task id.
 */
export function startProfile(instance: ServerInstance, seconds: number, timing: ProfileTiming = TIMING): string {
	if (!(PROFILE_SECONDS as readonly number[]).includes(seconds)) throw new SparkError('Pick one of the offered durations.');
	if (active.has(instance.id)) throw new SparkError('A profile is already running on this server.');
	const target = rconTarget(instance);
	const startedAt = Date.now();
	const profile: ActiveProfile = { taskId: '', startedAt, endsAt: startedAt + seconds * 1000 };
	active.set(instance.id, profile);
	profile.taskId = startTask({ label: `Profile ${instance.name}`, instanceId: instance.id }, async (task) => {
		try {
			await runProfile(instance, target, seconds, startedAt, task, timing);
		} finally {
			active.delete(instance.id);
		}
	});
	return profile.taskId;
}

async function runProfile(
	instance: ServerInstance,
	target: { port: number; password: string },
	seconds: number,
	startedAt: number,
	task: TaskHandle,
	timing: ProfileTiming
): Promise<void> {
	let confirmed = false;
	const tail = subscribeConsole(instance.id, 0, startedAt, (line) => {
		if (STARTED.test(line)) confirmed = true;
	});
	try {
		task.setProgress(0, 'Asking Spark to start');
		const [answer = ''] = await rconExec(target, [`spark profiler --timeout ${seconds}`]);
		// Spark itself answers later; anything said now is the server refusing the command.
		if (/unknown|incomplete|incorrect/i.test(answer)) {
			throw new SparkError(`The server did not take the command: ${answer.replace(/§./g, '').trim()}`);
		}
		const deadline = startedAt + seconds * 1000 + timing.uploadGraceMs;
		let lastStateCheck = Date.now();
		for (;;) {
			if (task.isCancelled()) {
				await rconExec(target, ['spark profiler --cancel']).catch(() => undefined);
				task.log('Cancelled; Spark discards the profile.');
				return;
			}
			const upload = (await sparkUploads(instance.path)).find((u) => u.time >= startedAt && isProfile(u));
			if (upload?.url) {
				task.log(`Uploaded: ${upload.url}`);
				task.setProgress(100, 'Uploaded');
				return;
			}
			if (upload?.file) {
				task.log(`Spark could not upload the profile and saved it to ${upload.file} instead.`);
				task.setProgress(100, 'Saved to disk');
				return;
			}
			const now = Date.now();
			if (!confirmed && now - startedAt > timing.confirmMs) {
				throw new SparkError(
					'Spark did not report starting a profiler. One may already be running (stop it in the console with "spark profiler --stop"), or this Spark build does not know "spark profiler".'
				);
			}
			if (now > deadline) throw new SparkError('Spark did not upload the profile in time. The console may say why.');
			if (now - lastStateCheck > timing.stateCheckMs) {
				lastStateCheck = now;
				if ((await unitState(instance.id)).active !== 'active') {
					throw new SparkError('The server stopped before the profile finished.');
				}
			}
			const left = Math.max(0, Math.ceil((startedAt + seconds * 1000 - now) / 1000));
			task.setProgress(
				Math.min(95, ((now - startedAt) / (seconds * 1000)) * 95),
				left > 0 ? `Profiling, ${left} s left` : 'Waiting for the upload'
			);
			await sleep(timing.pollMs);
		}
	} finally {
		tail.close();
	}
}

/** Ends the running profile early; Spark uploads what it has and the task picks the link up. */
export async function stopProfile(instance: ServerInstance): Promise<void> {
	if (!active.has(instance.id)) throw new SparkError('No profile started from MineShell is running.');
	await rconExec(rconTarget(instance), ['spark profiler --stop']);
}

export function cancelProfile(instance: ServerInstance): void {
	const profile = active.get(instance.id);
	if (!profile) throw new SparkError('No profile started from MineShell is running.');
	cancelTask(profile.taskId);
}
