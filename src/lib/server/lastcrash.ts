import { diagnoseRun, lastRun, type Diagnosis } from './crashdiag';
import { wasStopIntentional, type InstanceSummary } from './instances';
import { readLastRun } from './journal';
import { modsDir } from './mods/index';

/**
 * A crashed server's journal does not change between polls (the overview's
 * five seconds, the server list's), so the diagnosis is reused until a new
 * run appears.
 */
const diagnosisCache = new Map<string, { key: string; result: Promise<Diagnosis[]> }>();

function diagnoseLastRun(instanceId: string, instancePath: string, journal: string): Promise<Diagnosis[]> {
	const key = `${journal.length}:${journal.slice(-200)}`;
	const hit = diagnosisCache.get(instanceId);
	if (hit && hit.key === key) return hit.result;
	const result = diagnoseRun(journal, modsDir(instancePath)).catch(() => [] as Diagnosis[]);
	diagnosisCache.set(instanceId, { key, result });
	return result;
}

/** After the mods changed (a one-click fix), the same run diagnoses differently. */
export function forgetDiagnosis(instanceId: string): void {
	diagnosisCache.delete(instanceId);
}

export type LastCrash = { log: string; diagnosis: Promise<Diagnosis[]> };

/**
 * The last run, when it ended badly. A stop MineShell asked for reports the
 * same systemd Result as a crash, so intent is checked rather than inferred
 * from the unit state. Most loaders catch a startup crash, print it and exit
 * with code 0, so a systemd failure alone misses them: a run that stopped on
 * its own without ever reaching "Done (" counts as a crash too.
 */
export async function lastCrash(summary: InstanceSummary): Promise<LastCrash | null> {
	const { instance, state } = summary;
	if (summary.running || state.active === 'activating' || wasStopIntentional(instance.id)) return null;
	const log = lastRun(await readLastRun(instance.id, instance.createdAt));
	const startedRun = /^Started \S+\.service/.test(log);
	const crashed = state.active === 'failed' || state.result === 'exit-code' || (startedRun && !/\]: Done \(/.test(log));
	return crashed ? { log, diagnosis: diagnoseLastRun(instance.id, instance.path, log) } : null;
}

/**
 * One line for a server card: the diagnosis that stopped the server, or the
 * first one found. Null when nothing was recognised.
 */
export async function likelyCause(summary: InstanceSummary): Promise<string | null> {
	const crash = await lastCrash(summary);
	if (!crash) return null;
	const found = await crash.diagnosis;
	return (found.find((d) => d.fatal) ?? found[0])?.title ?? null;
}
