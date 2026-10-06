import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db/index.js';
import { serverInstances } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import {
	acceptEula,
	instanceDiskUsage,
	onlinePlayers,
	requireInstance,
	restart,
	start,
	stop,
	summarise,
	wasStopIntentional
} from '#lib/server/instances.js';
import { bucketSamples, recentSamples } from '#lib/server/monitor.js';
import { resolveJava } from '#lib/server/java.js';
import { cpus } from 'node:os';
import { primaryLanAddress } from '#lib/server/network.js';
import { describeSchedule } from '#lib/server/scheduler.js';
import { readLastRun, runFinishedStarting } from '#lib/server/journal.js';
import { diagnoseRun, lastRun, type Diagnosis } from '#lib/server/crashdiag.js';
import { modsDir, setModEnabled } from '#lib/server/mods/index.js';
import { cancelCountdown, getCountdown, startCountdown } from '#lib/server/countdown.js';
import { tickStats } from '#lib/server/tps.js';
import { kickPlayer } from '#lib/server/players.js';
import {
	activeProfile,
	cancelProfile,
	hasSpark,
	PROFILE_SECONDS,
	SparkError,
	sparkUploads,
	startProfile,
	stopProfile
} from '#lib/server/spark.js';

/**
 * The overview polls every few seconds; a crashed server's journal does not
 * change between polls, so the diagnosis is reused until a new run appears.
 */
const diagnosisCache = new Map<string, { key: string; result: Diagnosis[] }>();

async function diagnoseLastRun(instanceId: string, instancePath: string, journal: string): Promise<Diagnosis[]> {
	const key = `${journal.length}:${journal.slice(-200)}`;
	const hit = diagnosisCache.get(instanceId);
	if (hit && hit.key === key) return hit.result;
	const result = await diagnoseRun(journal, modsDir(instancePath));
	diagnosisCache.set(instanceId, { key, result });
	return result;
}

/**
 * A server still not "Done (" this long after starting is probably hung
 * (crash diagnosis only covers runs that ended). MeatballCraft, the biggest
 * pack here, takes about 95 s; a first start that also generates the world
 * takes several times that.
 */
const STUCK_AFTER_MS = 10 * 60_000;

/** Runs (by start time) already seen to finish starting; their log is not read again. */
const startedRuns = new Map<string, number>();

async function stuckStarting(instanceId: string, createdAt: number, startedAt: number): Promise<boolean> {
	if (!startedAt || Date.now() - startedAt < STUCK_AFTER_MS) return false;
	if (startedRuns.get(instanceId) === startedAt) return false;
	if (await runFinishedStarting(instanceId, createdAt)) {
		startedRuns.set(instanceId, startedAt);
		return false;
	}
	return true;
}

/** The performance chart's windows; the monitor keeps a day of samples. */
const RANGES = { '1h': 60 * 60 * 1000, '6h': 6 * 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 } as const;
type Range = keyof typeof RANGES;

export const load: PageServerLoad = async ({ params, url }) => {
	const instance = requireInstance(params.id);
	const summary = await summarise(instance);
	const requested = url.searchParams.get('range');
	const range: Range = requested && requested in RANGES ? (requested as Range) : '1h';
	const samples = bucketSamples(recentSamples(instance.id, RANGES[range]));
	// Shown only when the last run ended badly, so a crash is not silent. A
	// stop MineShell asked for reports the same systemd Result as a crash, so
	// intent is checked rather than inferred from the unit state. Most loaders
	// catch a startup crash, print it and exit with code 0, so a systemd
	// failure alone misses them: a run that stopped on its own without ever
	// reaching "Done (" counts as a crash too.
	let lastRunLog: string | null = null;
	let crashed = false;
	if (!summary.running && summary.state.active !== 'activating' && !wasStopIntentional(instance.id)) {
		lastRunLog = lastRun(await readLastRun(instance.id, instance.createdAt));
		const startedRun = /^Started \S+\.service/.test(lastRunLog);
		crashed =
			summary.state.active === 'failed' ||
			summary.state.result === 'exit-code' ||
			(startedRun && !/\]: Done \(/.test(lastRunLog));
	}
	// Both over RCON; side by side, so a slow answer is waited for once.
	const [players, tick] = summary.running
		? await Promise.all([onlinePlayers(instance), tickStats(instance)])
		: [null, null];
	const stuck = summary.running && (await stuckStarting(instance.id, instance.createdAt, summary.state.activeEnterTimestamp));
	// Which runtime actually gets used, so the overview can name it instead of
	// only saying that matching happens.
	const java = resolveJava({
		explicitPath: instance.javaPath,
		minecraftVersion: instance.minecraftVersion,
		modloader: instance.modloader,
		modloaderVersion: instance.modloaderVersion
	});

	const spark = (await hasSpark(instance.path))
		? {
				active: activeProfile(instance.id),
				durations: PROFILE_SECONDS,
				uploads: (await sparkUploads(instance.path)).slice(0, 5)
			}
		: null;

	return {
		summary: {
			uptimeMs: summary.uptimeMs,
			startedAt: summary.running ? summary.state.activeEnterTimestamp : null,
			javaWarning: summary.javaWarning,
			restarts: summary.state.nRestarts,
			mainPid: summary.state.mainPid,
			result: summary.state.result
		},
		detail: {
			jvmArgs: instance.jvmArgs,
			memoryMaxMb: instance.memoryMaxMb,
			memoryMinMb: instance.memoryMinMb,
			crashRestartWindowSec: instance.crashRestartWindowSec,
			javaPath: instance.javaPath,
			rconPort: instance.rconPort,
			autoRestartOnCrash: instance.autoRestartOnCrash,
			crashRestartLimit: instance.crashRestartLimit,
			schedule: describeSchedule(instance),
			nextRestartAt: instance.restartNextAt,
			createdAt: instance.createdAt,
			updatedAt: instance.updatedAt,
			notes: instance.notes,
			serverPort: instance.serverPort,
			minecraftVersion: instance.minecraftVersion,
			modloaderVersion: instance.modloaderVersion,
			java: {
				path: java.path,
				majorVersion: java.majorVersion,
				requiredMajor: java.requiredMajor,
				origin: java.origin
			},
			// The address players actually connect to. The bind address is usually
			// blank (all interfaces). A bare hostname needs mDNS or local DNS to
			// resolve from another LAN machine, which most home networks don't
			// have set up (confirmed: it doesn't resolve here) - the LAN IPv4
			// address is what actually works, so that's shown instead.
			host: primaryLanAddress()
		},
		players,
		countdown: getCountdown(instance.id),
		tick,
		spark,
		stuckSince: stuck ? summary.state.activeEnterTimestamp : null,
		diskBytes: await instanceDiskUsage(instance),
		// CPU is measured across all cores, so the chart needs the core count to
		// show a meaningful ceiling instead of an unexplained 400%.
		cpuCores: cpus().length || 1,
		range,
		rangeMs: RANGES[range],
		cpu: samples.map((s) => ({ timestamp: s.timestamp, value: s.cpuPercent })),
		memory: samples.map((s) => ({ timestamp: s.timestamp, value: s.memoryBytes })),
		crashTail: crashed && lastRunLog ? lastRunLog.split('\n').slice(-40).join('\n') : null,
		// Streamed: indexing a big pack's mods takes a moment the first time.
		diagnosis:
			crashed && lastRunLog
				? diagnoseLastRun(instance.id, instance.path, lastRunLog).catch(() => [] as Diagnosis[])
				: null
	};
};

export const actions: Actions = {
	power: async ({ request, params, url }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const verb = String(form.get('verb') ?? '');
		// The header menu's buttons carry the verb, so their delay is in the URL.
		const delay = Number(form.get('delay') ?? url.searchParams.get('delay') ?? 0);
		if ((verb === 'stop' || verb === 'restart') && Number.isInteger(delay) && delay > 0 && delay <= 3600) {
			const result = await startCountdown(instance, verb, delay);
			return result.ok ? result : fail(400, result);
		}
		// Acting by hand replaces any countdown still running.
		cancelCountdown(instance.id);
		const result =
			verb === 'start'
				? await start(instance)
				: verb === 'stop'
					? await stop(instance)
					: verb === 'kill'
						? await stop(instance, { graceful: false })
						: verb === 'restart'
							? await restart(instance)
							: { ok: false, message: `Unknown action "${verb}".` };
		return result.ok ? result : fail(400, result);
	},

	cancelCountdown: async ({ params }) => {
		return cancelCountdown(params.id)
			? { ok: true, message: 'Countdown cancelled; players were told.' }
			: fail(400, { ok: false, message: 'No countdown is running.' });
	},

	/** One-click fix from a crash diagnosis: disable the culprit or re-enable a dependency. */
	modFix: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const form = await request.formData();
		const fileName = String(form.get('fileName') ?? '');
		const enable = form.get('enable') === 'true';
		if (!fileName || fileName.includes('/') || fileName.includes('..')) {
			return fail(400, { ok: false, message: 'No mod given.' });
		}
		if ((await summarise(instance)).running) {
			return fail(400, { ok: false, message: 'Stop the server first.' });
		}
		try {
			await setModEnabled(instance, fileName, enable);
		} catch {
			return fail(400, { ok: false, message: `${fileName} is no longer in the mods folder.` });
		}
		diagnosisCache.delete(instance.id);
		const name = fileName.replace(/\.jar(\.disabled)?$/i, '');
		return { ok: true, message: `${enable ? 'Enabled' : 'Disabled'} ${name}. Start the server to try again.` };
	},

	profile: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const seconds = Number((await request.formData()).get('seconds'));
		if (!(await summarise(instance)).running) return fail(400, { ok: false, message: 'Start the server first.' });
		try {
			startProfile(instance, seconds);
		} catch (err) {
			if (err instanceof SparkError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
		return { ok: true, message: 'Profiling. The link appears below when Spark has uploaded the result.' };
	},

	profileStop: async ({ params }) => {
		try {
			await stopProfile(requireInstance(params.id));
		} catch (err) {
			return fail(400, { ok: false, message: err instanceof SparkError ? err.message : 'Spark did not answer over RCON.' });
		}
		return { ok: true, message: 'Stopping; Spark uploads what it has so far.' };
	},

	profileCancel: async ({ params }) => {
		try {
			cancelProfile(requireInstance(params.id));
		} catch (err) {
			if (err instanceof SparkError) return fail(400, { ok: false, message: err.message });
			throw err;
		}
		return { ok: true, message: 'Profile cancelled.' };
	},

	kick: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const name = String((await request.formData()).get('name') ?? '').trim();
		if (!name) return fail(400, { ok: false, message: 'No player given.' });
		if ((await kickPlayer(instance, name, '')) === null) {
			return fail(400, { ok: false, message: 'The server is not reachable over RCON.' });
		}
		return { ok: true, message: `Kicked ${name}.` };
	},

	eula: async ({ params }) => {
		await acceptEula(requireInstance(params.id));
		return { ok: true, message: 'EULA accepted. You can start the server now.' };
	},

	/**
	 * What an install or pack change reported (client-only mods disabled,
	 * Cleanroom fixes that failed) stays on a ready server until read. Only
	 * that: a failed setup's message is the reason it failed.
	 */
	dismissNotice: async ({ params }) => {
		const instance = requireInstance(params.id);
		if (instance.status !== 'ready') return fail(400, { ok: false, message: 'Nothing to dismiss.' });
		db.update(serverInstances)
			.set({ statusMessage: null })
			.where(eq(serverInstances.id, instance.id))
			.run();
		return { ok: true };
	},

	pin: async ({ params }) => {
		const instance = requireInstance(params.id);
		db.update(serverInstances)
			.set({ pinned: !instance.pinned, updatedAt: Date.now() })
			.where(eq(serverInstances.id, instance.id))
			.run();
		return { ok: true, message: instance.pinned ? 'Unpinned.' : 'Pinned to the top of the list.' };
	},

	notes: async ({ request, params }) => {
		const instance = requireInstance(params.id);
		const notes = String((await request.formData()).get('notes') ?? '').slice(0, 4000);
		db.update(serverInstances)
			.set({ notes, updatedAt: Date.now() })
			.where(eq(serverInstances.id, instance.id))
			.run();
		return { ok: true, message: 'Notes saved.' };
	}
};
