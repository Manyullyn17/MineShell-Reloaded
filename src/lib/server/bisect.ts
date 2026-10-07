import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { bisectSessions, serverInstances, settings, type ServerInstance } from './db/schema';
import { diagnoseRun, indexMods, lastRun } from './crashdiag';
import { startTimes } from './history';
import { getInstance, InstanceError, requireStopped, setWantedRunning, start, stop, syncUnit } from './instances';
import { readLastRun } from './journal';
import { DISABLED_SUFFIX, modsDir, setModEnabled } from './mods/index';
import { beginOperation, endOperation, listOperations, type Journal } from './operations';
import { patchProperties, readProperties } from './properties';
import { resetFailed, unitState } from './systemd';
import { startTask, type TaskHandle } from './tasks';

/**
 * The mod bisect assistant: finds the mod (or the pair of mods) a crash comes
 * from by starting the server with fewer and fewer of them.
 *
 * Every enabled mod is a suspect except the ones the user keeps on. The first
 * test starts with all of them (the crash must happen), the second with none
 * (it must not). Then the suspects are halved: whichever half still crashes is
 * searched further. When neither half crashes alone, two mods are involved:
 * one half stays on while the other is searched, which finds one of them, then
 * its partner (delta debugging). A test enables a mod's dependencies with it
 * (from the jars' own declarations, plus what failed tests teach), since a
 * missing library would crash for its own reason.
 *
 * Test runs never touch the real world: level-name points at a throwaway
 * world for the duration, since starting a world with mods missing deletes
 * their blocks and items from it. config/ is copied aside and put back,
 * because mods rewrite configs when others are missing. Crash restarts are
 * off for the tests. All of it is journalled (`bisect`): an interrupted
 * bisect is put back by recovery, through the same restore as its end.
 * Test runs are recorded as such (`bisect_sessions`), so they stay out of
 * crash history and start times.
 */

export const BISECT_WORLD = 'mineshell-bisect-world';
const CONFIG_BACKUP = path.join('.mineshell', 'bisect-config');
/** How often a test looks at the server, and how long after "Done (" it watches for the log text. Tests shorten them. */
export const bisectTiming = { pollMs: 3000, textGraceMs: 30_000 };
const MIN_TEST_MS = 10 * 60_000;

export type BisectJournal = Extract<Journal, { kind: 'bisect' }>;

export type BisectTest = {
	enabled: number;
	result: 'problem' | 'fine' | 'retried';
	note: string;
	at: number;
};

export type BisectState = {
	status: 'running' | 'found' | 'not-reproduced' | 'without-suspects' | 'stuck' | 'cancelled' | 'failed';
	startedAt: number;
	finishedAt: number | null;
	suspects: number;
	remaining: number;
	estimate: number;
	tests: BisectTest[];
	/** Jar file names (as enabled, without .disabled) the problem comes from. */
	culprits: string[];
	message: string | null;
	logText: string | null;
	taskId: string | null;
};

const STATE_KEY = (id: string) => `bisect.state:${id}`;

export function bisectState(instanceId: string): BisectState | null {
	const row = db.select().from(settings).where(eq(settings.key, STATE_KEY(instanceId))).get();
	try {
		return row ? (JSON.parse(row.value) as BisectState) : null;
	} catch {
		return null;
	}
}

function saveState(instanceId: string, state: BisectState): void {
	const value = JSON.stringify(state);
	db.insert(settings).values({ key: STATE_KEY(instanceId), value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

export function clearBisectState(instanceId: string): void {
	db.delete(settings).where(eq(settings.key, STATE_KEY(instanceId))).run();
}

export function isBisecting(instanceId: string): boolean {
	return listOperations().some((o) => o.instanceId === instanceId && o.journal.kind === 'bisect');
}

const base = (fileName: string) => (fileName.endsWith(DISABLED_SUFFIX) ? fileName.slice(0, -DISABLED_SUFFIX.length) : fileName);

/** About how many starts a bisect of `n` suspects takes: the two checks, then halving. */
export function estimateTests(n: number): number {
	return n <= 1 ? 2 : 2 + Math.ceil(Math.log2(n));
}

// ---------------------------------------------------------------- restore ---

async function copyDir(from: string, to: string): Promise<void> {
	await fs.cp(from, to, { recursive: true, force: true, errorOnExist: false });
}

/**
 * Puts the server back as it was before the bisect: mods on/off, level-name,
 * config/, crash restarts and the after-reboot setting; removes the throwaway
 * world. Used at the end of every bisect and by recovery after a crash.
 */
export async function restoreBisect(instance: ServerInstance, journal: BisectJournal): Promise<void> {
	const dir = modsDir(instance.path);
	const enabledBefore = new Set(journal.enabledBefore);
	for (const file of await fs.readdir(dir).catch(() => [] as string[])) {
		if (!/\.jar(\.disabled)?$/i.test(file)) continue;
		const want = enabledBefore.has(base(file));
		if (want !== !file.endsWith(DISABLED_SUFFIX)) await setModEnabled(instance, file, want);
	}
	await patchProperties(instance.path, { 'level-name': journal.levelName });
	const backup = path.join(instance.path, CONFIG_BACKUP);
	if (await fs.stat(backup).then(() => true, () => false)) {
		await fs.rm(path.join(instance.path, 'config'), { recursive: true, force: true });
		await copyDir(backup, path.join(instance.path, 'config'));
		await fs.rm(backup, { recursive: true, force: true });
	}
	await fs.rm(path.join(instance.path, BISECT_WORLD), { recursive: true, force: true });
	db.update(serverInstances)
		.set({ autoRestartOnCrash: journal.autoRestartBefore, wantedRunning: journal.wantedRunningBefore })
		.where(eq(serverInstances.id, instance.id))
		.run();
	db.update(bisectSessions).set({ endedAt: Date.now() }).where(eq(bisectSessions.instanceId, instance.id)).run();
	// The last test may have crashed on purpose: systemd's "failed" would show as a crash of the server.
	await resetFailed(instance.id).catch(() => undefined);
	const fresh = getInstance(instance.id);
	if (fresh) await syncUnit(fresh).catch(() => undefined);
}

// ------------------------------------------------------------------ tests ---

type Outcome = { problem: boolean; note: string; log: string };

async function waitStopped(id: string, ms: number): Promise<boolean> {
	const until = Date.now() + ms;
	for (;;) {
		const s = await unitState(id, { fresh: true }).catch(() => null);
		if (!s || s.active === 'inactive' || s.active === 'failed') return true;
		if (Date.now() > until) return false;
		await new Promise((r) => setTimeout(r, bisectTiming.pollMs));
	}
}

async function stopTest(instance: ServerInstance): Promise<void> {
	await stop(instance, { internal: true });
	if (!(await waitStopped(instance.id, 6 * 60_000))) await stop(instance, { graceful: false, internal: true });
	await waitStopped(instance.id, 60_000);
}

/** Starts the server with exactly `enabled` (jar base names) on and reports whether the problem showed. */
async function runTest(
	instance: ServerInstance,
	enabled: Set<string>,
	opts: { logText: string | null; timeoutMs: number; cancelled: () => boolean }
): Promise<Outcome> {
	const dir = modsDir(instance.path);
	for (const file of await fs.readdir(dir)) {
		if (!/\.jar(\.disabled)?$/i.test(file)) continue;
		const want = enabled.has(base(file));
		if (want !== !file.endsWith(DISABLED_SUFFIX)) await setModEnabled(instance, file, want);
	}
	const started = await start(getInstance(instance.id)!, { internal: true });
	if (!started.ok) throw new InstanceError(started.message);

	const deadline = Date.now() + opts.timeoutMs;
	let doneAt: number | null = null;
	for (;;) {
		await new Promise((r) => setTimeout(r, bisectTiming.pollMs));
		const log = lastRun(await readLastRun(instance.id, instance.createdAt));
		if (opts.cancelled()) {
			await stopTest(instance);
			return { problem: false, note: 'cancelled', log };
		}
		if (opts.logText && log.includes(opts.logText)) {
			await stopTest(instance);
			return { problem: true, note: 'the log text appeared', log };
		}
		const state = await unitState(instance.id, { fresh: true }).catch(() => null);
		if (doneAt === null && /\]: Done \(/.test(log)) doneAt = Date.now();
		if (doneAt !== null && (!opts.logText || Date.now() - doneAt > bisectTiming.textGraceMs)) {
			await stopTest(instance);
			return { problem: false, note: 'started fine', log };
		}
		if (doneAt === null && state && (state.active === 'inactive' || state.active === 'failed')) {
			return { problem: true, note: 'crashed while starting', log };
		}
		if (Date.now() > deadline) {
			await stopTest(instance);
			return { problem: true, note: `still not started after ${Math.round(opts.timeoutMs / 60_000)} minutes`, log };
		}
	}
}

// -------------------------------------------------------------- the search ---

class Stuck extends Error {}
class Cancelled extends Error {}

export async function startBisect(instance: ServerInstance, opts: { keepOn: string[]; logText: string | null }): Promise<string> {
	await requireStopped(instance);
	const jars = await indexMods(modsDir(instance.path));
	const enabledBefore = jars.filter((j) => j.enabled).map((j) => base(j.fileName));
	const keepOn = new Set(opts.keepOn.map(base).filter((f) => enabledBefore.includes(f)));
	const suspects = enabledBefore.filter((f) => !keepOn.has(f)).sort((a, b) => a.localeCompare(b));
	if (suspects.length === 0) throw new InstanceError('Every enabled mod is kept on: there is nothing to search.');

	const levelName = (await readProperties(instance.path)).values['level-name'] || 'world';
	const journal: BisectJournal = {
		kind: 'bisect',
		levelName,
		enabledBefore,
		autoRestartBefore: instance.autoRestartOnCrash,
		wantedRunningBefore: instance.wantedRunning
	};
	beginOperation(instance.id, journal);
	db.insert(bisectSessions).values({ instanceId: instance.id, startedAt: Date.now() }).run();

	const state: BisectState = {
		status: 'running',
		startedAt: Date.now(),
		finishedAt: null,
		suspects: suspects.length,
		remaining: suspects.length,
		estimate: estimateTests(suspects.length),
		tests: [],
		culprits: [],
		message: null,
		logText: opts.logText,
		taskId: null
	};
	saveState(instance.id, state);

	const taskId = startTask({ label: `Find what makes ${instance.name} crash`, instanceId: instance.id }, async (task) => {
		try {
			await prepare(instance);
			await search(instance, { jars, keepOn, suspects, logText: opts.logText, state, task });
		} catch (err) {
			if (err instanceof Cancelled) {
				state.status = 'cancelled';
				state.message = 'Cancelled; the server is back as it was.';
			} else if (err instanceof Stuck) {
				state.status = 'stuck';
				state.message = err.message;
			} else {
				state.status = 'failed';
				state.message = err instanceof Error ? err.message : String(err);
			}
		} finally {
			task.setProgress(99, 'Putting the server back');
			await restoreBisect(getInstance(instance.id) ?? instance, journal).catch((err) => {
				state.message = `${state.message ?? ''} Putting the server back failed: ${err instanceof Error ? err.message : err}`.trim();
			});
			endOperation(instance.id);
			cancels.delete(instance.id);
			state.finishedAt = Date.now();
			saveState(instance.id, state);
		}
		if (state.status === 'failed') throw new Error(state.message ?? 'The bisect failed.');
	});
	state.taskId = taskId;
	saveState(instance.id, state);
	return taskId;
}

const cancels = new Set<string>();

export function cancelBisect(instanceId: string): void {
	if (isBisecting(instanceId)) cancels.add(instanceId);
}

/** Throwaway world, config/ aside, no crash restarts, before the first test. */
async function prepare(instance: ServerInstance): Promise<void> {
	await fs.rm(path.join(instance.path, BISECT_WORLD), { recursive: true, force: true });
	await patchProperties(instance.path, { 'level-name': BISECT_WORLD });
	const config = path.join(instance.path, 'config');
	if (await fs.stat(config).then(() => true, () => false)) {
		await fs.rm(path.join(instance.path, CONFIG_BACKUP), { recursive: true, force: true });
		await copyDir(config, path.join(instance.path, CONFIG_BACKUP));
	}
	db.update(serverInstances).set({ autoRestartOnCrash: false }).where(eq(serverInstances.id, instance.id)).run();
	await syncUnit(getInstance(instance.id)!);
}

async function search(
	instance: ServerInstance,
	ctx: {
		jars: Awaited<ReturnType<typeof indexMods>>;
		keepOn: Set<string>;
		suspects: string[];
		logText: string | null;
		state: BisectState;
		task: TaskHandle;
	}
): Promise<void> {
	const { keepOn, suspects, state, task } = ctx;
	const suspectSet = new Set(suspects);

	// Requirements between jars, by file: from their declarations, and learned from tests.
	const byId = new Map<string, string>();
	for (const j of ctx.jars) for (const id of j.ids) byId.set(id, base(j.fileName));
	const requires = new Map<string, Set<string>>();
	for (const j of ctx.jars) {
		const deps = new Set<string>();
		for (const id of j.requires) {
			const file = byId.get(id);
			if (file && file !== base(j.fileName)) deps.add(file);
		}
		requires.set(base(j.fileName), deps);
	}
	const closure = (set: Iterable<string>) => {
		const out = new Set<string>();
		const queue = [...set];
		while (queue.length) {
			const f = queue.pop()!;
			if (out.has(f) || !suspectSet.has(f)) continue;
			out.add(f);
			for (const d of requires.get(f) ?? []) queue.push(d);
		}
		return out;
	};

	const usual = startTimes(instance.id)?.usualMs ?? startTimes(instance.id)?.lastMs ?? null;
	const timeoutMs = Math.max(MIN_TEST_MS, (usual ?? 0) * 3);
	const memo = new Map<string, boolean>();

	const crashes = async (set: Iterable<string>, label: string): Promise<boolean> => {
		for (let attempt = 0; attempt < 8; attempt++) {
			if (cancels.has(instance.id)) throw new Cancelled();
			const enabled = new Set([...keepOn, ...closure(set)]);
			const key = [...enabled].sort().join('|');
			const known = memo.get(key);
			if (known !== undefined) return known;
			const n = enabled.size - keepOn.size;
			task.setProgress(Math.min(95, (state.tests.length / state.estimate) * 100), `Test ${state.tests.length + 1}: ${label} (${n} suspect${n === 1 ? '' : 's'} on)`);
			const outcome = await runTest(getInstance(instance.id)!, enabled, {
				logText: ctx.logText,
				timeoutMs,
				cancelled: () => cancels.has(instance.id)
			});
			if (cancels.has(instance.id)) throw new Cancelled();
			if (outcome.problem) {
				// A mod left without a library it needs crashes for that reason, not the one searched for.
				const found = await diagnoseRun(outcome.log, modsDir(instance.path)).catch(() => []);
				const learned = found.filter(
					(d) => d.kind === 'disabled-dependency' && d.culprit && d.related && enabled.has(base(d.culprit.fileName)) && !enabled.has(base(d.related.fileName))
				);
				if (learned.length) {
					for (const d of learned) requires.get(base(d.culprit!.fileName))?.add(base(d.related!.fileName));
					state.tests.push({ enabled: n, result: 'retried', note: `${learned.map((d) => d.title).join('; ')}: tried again with it on`, at: Date.now() });
					saveState(instance.id, state);
					continue;
				}
			}
			state.tests.push({ enabled: n, result: outcome.problem ? 'problem' : 'fine', note: outcome.note, at: Date.now() });
			saveState(instance.id, state);
			task.log(`${label}: ${outcome.problem ? 'the problem showed' : 'fine'} (${outcome.note}, ${n} on)`);
			memo.set(key, outcome.problem);
			return outcome.problem;
		}
		throw new Stuck('Tests kept failing on missing dependencies; the search could not narrow it down.');
	};

	if (!(await crashes(suspects, 'everything on'))) {
		state.status = 'not-reproduced';
		state.message = ctx.logText
			? `With every mod on, the server started and "${ctx.logText}" did not appear, so there is nothing to search for.`
			: 'With every mod on, the server started fine (on a fresh world), so there is nothing to search for.';
		return;
	}
	if (await crashes([], 'every suspect off')) {
		state.status = 'without-suspects';
		state.message = 'The problem shows even with every suspect off: it comes from a mod kept on, the loader, or something other than mods.';
		return;
	}

	/** Minimal part of `candidates` the problem needs, with `fixed` always on (ddmin). */
	const find = async (candidates: string[], fixed: string[]): Promise<string[]> => {
		state.remaining = candidates.length;
		saveState(instance.id, state);
		if (candidates.length <= 1) return candidates;
		const half = Math.ceil(candidates.length / 2);
		const a = candidates.slice(0, half);
		const b = candidates.slice(half);
		const whole = closure([...fixed, ...candidates]).size;
		const smaller = (part: string[]) => closure([...fixed, ...part]).size < whole;
		if (!smaller(a) && !smaller(b)) {
			throw new Stuck(`${candidates.length} mods are tied together by their dependencies, so they cannot be told apart: ${candidates.join(', ')}.`);
		}
		const aAlone = smaller(a);
		const bAlone = smaller(b);
		if (aAlone && (await crashes([...fixed, ...a], 'first half'))) return find(a, fixed);
		if (bAlone && (await crashes([...fixed, ...b], 'second half'))) return find(b, fixed);
		// A half that cannot go on without the other (it depends on it), while the other alone
		// is fine: the problem is in that half, its dependencies simply always come along.
		if (!bAlone) return find(b, fixed);
		if (!aAlone) return find(a, fixed);
		// Neither half alone: one mod from each is needed.
		const fromA = await find(a, [...fixed, ...b]);
		const fromB = await find(b, [...fixed, ...fromA]);
		return [...fromA, ...fromB];
	};

	state.culprits = await find(suspects, []);
	state.remaining = state.culprits.length;
	state.status = 'found';
	state.message = null;
	task.setProgress(98, 'Found');
}
